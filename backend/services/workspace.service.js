import crypto from "node:crypto";
import mongoose from "mongoose";
import Workspace from "../models/Workspace.model.js";
import WorkspaceMember, { WORKSPACE_ROLES, roleAtLeast } from "../models/WorkspaceMember.model.js";
import Document from "../models/doc.model.js";
import Attachment from "../models/Attachment.model.js";
import User from "../models/User.model.js";
import { ApiError } from "../utils/ApiError.js";
import { DEFAULT_PLAN, describeLimitBreach, planFor } from "../config/plans.js";
import * as audit from "./audit.service.js";

/**
 * Workspaces (master plan section 36).
 *
 * Every user has one personal workspace created for them; a team is a second
 * workspace they invite people into. The two are the same object, which keeps
 * "whose documents are these" answerable with a single field lookup.
 *
 * Roles, highest first: owner > admin > editor > member > viewer.
 */

const MAX_NAME = 120;

/** True for a value that could be an ObjectId. Avoids a cast error on bad input. */
function isId(value) {
  return mongoose.isValidObjectId(value);
}

/** URL-safe slug with a short suffix, so two workspaces called "Design" can coexist. */
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Create a workspace and its first owner membership.
 *
 * @param {object} owner A User document.
 * @param {{name: string, isPersonal?: boolean}} params
 */
async function createWorkspace(owner, { name, isPersonal = false } = {}) {
  const clean = String(name || "").trim();
  if (!clean) throw new ApiError(400, "A workspace name is required");
  if (clean.length > MAX_NAME) throw new ApiError(400, "That workspace name is too long");

  const workspace = await Workspace.create({
    name: clean,
    slug: slugify(clean),
    owner: owner._id,
    isPersonal,
    plan: DEFAULT_PLAN,
    stats: { documents: 0, members: 1 },
  });

  await WorkspaceMember.create({
    workspace: workspace._id,
    user: owner._id,
    role: "owner",
    status: "active",
  });

  await audit.record(workspace._id, {
    action: "workspace.created",
    actor: owner,
    resource: { type: "workspace", id: workspace._id, name: workspace.name },
    meta: { isPersonal },
  });

  return workspace;
}

/**
 * The user's personal workspace, created on first use.
 *
 * Accepts either a User document or a JWT payload, because the two reach this
 * function from different places and the payload carries only `id` and `email`.
 *
 * Idempotent and race safe: two parallel requests cannot both create one, because
 * the unique index on `{owner, isPersonal}` makes the loser fail and retry as a
 * lookup.
 */
export async function ensurePersonalWorkspace(owner) {
  const ownerId = owner?._id || owner?.id;
  if (!isId(ownerId)) throw new ApiError(401, "Sign in to continue");

  const existing = await Workspace.findOne({ owner: ownerId, isPersonal: true });
  if (existing) return existing;

  // "My Documents" reads better in a personal space than the person's name, but a
  // name is nicer when we happen to have one. A JWT payload does not, so this
  // costs a single read on the very first request of an account's life.
  let name = owner?.name;
  if (!name) {
    name = (await User.findById(ownerId).select("name").lean())?.name;
  }

  try {
    const created = await createWorkspace({ _id: ownerId, name }, { name: name ? `${name}'s documents` : "My documents", isPersonal: true });
    // Documents created before workspaces existed belong to this new space. `{null}`
    // matches both a missing field and an explicit null.
    await Document.updateMany(
      { owner: ownerId, workspace: null },
      { $set: { workspace: created._id } }
    );
    await refreshStats(created._id);
    return created;
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await Workspace.findOne({ owner: ownerId, isPersonal: true });
      if (raced) return raced;
    }
    throw err;
  }
}

/** Recount the cached workspace stats. Cheap enough to run after a bulk change. */
export async function refreshStats(workspaceId) {
  const [documents, storage, attachments] = await Promise.all([
    Document.countDocuments({ workspace: workspaceId, trashedAt: null }),
    Document.aggregate([
      { $match: { workspace: workspaceId, trashedAt: null } },
      { $group: { _id: null, bytes: { $sum: { $strLenBytes: { $ifNull: ["$content", ""] } } } } },
    ]),
    // Attached files live outside Mongo, so their size has to be counted from the
    // metadata rows. Without this the plan's storage quota would ignore exactly
    // the thing that fills a disk.
    Attachment.aggregate([
      { $match: { workspace: workspaceId } },
      { $group: { _id: null, bytes: { $sum: "$bytes" } } },
    ]),
  ]);

  const members = await WorkspaceMember.countDocuments({
    workspace: workspaceId,
    status: "active",
  });

  await Workspace.updateOne(
    { _id: workspaceId },
    {
      $set: {
        "stats.documents": documents,
        "stats.members": members,
        "stats.storageBytes":
          (storage[0]?.bytes || 0) + (attachments[0]?.bytes || 0),
      },
    }
  );
}

/** Workspaces the user belongs to, personal one first. */
export async function listForUser(userId) {
  const memberships = await WorkspaceMember.find({ user: userId, status: "active" })
    .select("workspace role")
    .lean();
  if (!memberships.length) return [];

  const ids = memberships.map((m) => m.workspace);
  const workspaces = await Workspace.find({
    _id: { $in: ids },
    trashedAt: null,
  }).lean();

  const roleById = new Map(memberships.map((m) => [String(m.workspace), m.role]));
  return workspaces
    .map((w) => ({ ...serialize(w), myRole: roleById.get(String(w._id)) || null }))
    .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name));
}

function serialize(workspace) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug,
    owner: String(workspace.owner),
    isPersonal: workspace.isPersonal,
    plan: workspace.plan,
    planExpiresAt: workspace.planExpiresAt,
    stats: {
      documents: workspace.stats?.documents || 0,
      members: workspace.stats?.members || 0,
      storageBytes: workspace.stats?.storageBytes || 0,
    },
    limits: planFor(workspace.plan),
    createdAt: workspace.createdAt,
  };
}

/** The caller's role in a workspace, or null when they are not a member. */
export async function memberRole(workspaceId, userId) {
  if (!isId(workspaceId) || !isId(userId)) return null;
  const membership = await WorkspaceMember.findOne({
    workspace: workspaceId,
    user: userId,
    status: "active",
  })
    .select("role")
    .lean();
  return membership?.role || null;
}

/**
 * Load a workspace and assert the caller holds at least `minimum`.
 *
 * A non-member must not be able to tell a real workspace apart from a missing
 * one, so both return 404.
 */
export async function authorize(workspaceId, userId, minimum = "viewer") {
  if (!isId(workspaceId)) throw new ApiError(404, "Workspace not found");

  const workspace = await Workspace.findOne({ _id: workspaceId, trashedAt: null });
  if (!workspace) throw new ApiError(404, "Workspace not found");

  const role = await memberRole(workspaceId, userId);
  if (!role) throw new ApiError(404, "Workspace not found");
  if (!roleAtLeast(role, minimum)) {
    throw new ApiError(403, `You need the ${minimum} role in this workspace`);
  }

  return { workspace, role };
}

/** A non-mutating lookup used by the quota and audit paths. */
export async function getWorkspace(workspaceId) {
  if (!isId(workspaceId)) return null;
  return Workspace.findOne({ _id: workspaceId, trashedAt: null });
}

/**
 * The workspace an action should be billed and logged against.
 *
 * Personal by default, so every existing call site keeps working and every user
 * is never left without one.
 */
export async function resolveWorkspace(userId, workspaceId = null) {
  if (workspaceId) {
    const workspace = await getWorkspace(workspaceId);
    if (workspace) return workspace;
  }
  const user = await User.findById(userId).select("_id name");
  if (!user) throw new ApiError(404, "User not found");
  return ensurePersonalWorkspace(user);
}

export async function createTeam(userId, { name } = {}, req) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  // The personal workspace counts towards the ceiling, because it is one of the
  // workspaces this account is using.
  const owned = await WorkspaceMember.countDocuments({ user: userId, status: "active" });
  const limit = planFor(DEFAULT_PLAN).maxWorkspaces;
  if (owned >= limit) {
    throw new ApiError(
      409,
      `You are using ${owned} of the ${limit} workspaces included on the ${planFor(DEFAULT_PLAN).name} plan.`
    );
  }

  // createWorkspace already writes the creation entry to the audit log.
  return serialize((await createWorkspace(user, { name, isPersonal: false })).toObject());
}

export async function updateWorkspace(workspaceId, userId, { name }, req) {
  const { workspace } = await authorize(workspaceId, userId, "admin");

  const clean = String(name || "").trim();
  if (!clean) throw new ApiError(400, "A workspace name is required");
  if (clean.length > MAX_NAME) throw new ApiError(400, "That workspace name is too long");

  const before = workspace.name;
  workspace.name = clean;
  await workspace.save();

  await audit.record(workspaceId, {
    action: "workspace.updated",
    actor: { id: userId },
    resource: { type: "workspace", id: workspaceId, name: clean },
    req,
    meta: { from: before, to: clean },
  });

  return serialize(workspace.toObject());
}

/**
 * Move a workspace onto another plan.
 *
 * There is no payment here yet, so this is the hook a billing webhook will call
 * rather than a self-serve upgrade. The guard below is what keeps it that way: an
 * owner must not be able to grant their own team Pro for free. Billing sets
 * BILLING_ENABLED=true once real checkout exists, and an admin route takes over
 * from there.
 */
export async function changePlan(workspaceId, userId, { plan, actor }, req) {
  if (process.env.BILLING_ENABLED !== "true") {
    throw new ApiError(403, "Plan changes are not enabled on this deployment");
  }

  const { workspace } = await authorize(workspaceId, userId, "owner");

  const next = String(plan || "").trim().toLowerCase();
  // `planFor` falls back to the default for anything unknown, so compare the
  // resolved id instead: that only matches when the name was a real plan.
  if (planFor(next).id !== next) throw new ApiError(400, "Unknown plan");

  const before = workspace.plan;
  if (before === next) return serialize(workspace.toObject());

  workspace.plan = next;
  workspace.planExpiresAt = null;
  await workspace.save();

  await audit.record(workspaceId, {
    action: "billing.plan_changed",
    actor: actor || { id: userId },
    resource: { type: "workspace", id: workspaceId, name: workspace.name },
    req,
    meta: { from: before, to: next },
  });

  return serialize(workspace.toObject());
}

/** Move between trash and back. Owners only; members cannot delete a workspace. */
export async function trashWorkspace(workspaceId, userId, req) {
  const { workspace } = await authorize(workspaceId, userId, "owner");
  workspace.trashedAt = new Date();
  await workspace.save();

  await audit.record(workspaceId, {
    action: "workspace.deleted",
    actor: { id: userId },
    resource: { type: "workspace", id: workspaceId, name: workspace.name },
    req,
  });
  return { trashed: true };
}

export async function restoreWorkspace(workspaceId, userId, req) {
  if (!isId(workspaceId)) throw new ApiError(404, "Workspace not found");

  // A trashed workspace is invisible to `authorize`, so restoring has to look past
  // that filter. The role check below is what actually decides access.
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new ApiError(404, "Workspace not found");
  if (!workspace.trashedAt) return { restored: true };

  const role = await memberRole(workspaceId, userId);
  if (!role) throw new ApiError(404, "Workspace not found");
  if (!roleAtLeast(role, "owner")) {
    throw new ApiError(403, "You need the owner role in this workspace");
  }

  workspace.trashedAt = null;
  await workspace.save();

  await audit.record(workspaceId, {
    action: "workspace.updated",
    actor: { id: userId },
    resource: { type: "workspace", id: workspaceId, name: workspace.name },
    req,
    meta: { restored: true },
  });
  return { restored: true };
}

/**
 * Members
 */

export async function listMembers(workspaceId, userId) {
  const { workspace } = await authorize(workspaceId, userId, "member");
  const members = await WorkspaceMember.find({ workspace: workspace._id })
    .populate("user", "name email avatar")
    .sort({ status: 1, createdAt: 1 })
    .lean();

  return members.map((m) => ({
    id: String(m._id),
    user: m.user ? String(m.user._id) : null,
    name: m.user?.name || null,
    email: m.user?.email || m.email || null,
    avatar: m.user?.avatar || null,
    role: m.role,
    status: m.status,
    lastActiveAt: m.lastActiveAt,
    createdAt: m.createdAt,
  }));
}

/**
 * Invite somebody by email.
 *
 * An address that already has an account is added straight away; anything else
 * becomes a pending invitation that a future signup can claim. Seats are capped
 * by the plan.
 */
export async function inviteMember(workspaceId, userId, { email, role = "member" } = {}, req) {
  const { workspace } = await authorize(workspaceId, userId, "admin");

  if (workspace.isPersonal) {
    throw new ApiError(400, "A personal workspace cannot have members");
  }

  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) throw new ApiError(400, "A valid email address is required");
  if (!WORKSPACE_ROLES.includes(role)) throw new ApiError(400, "Unknown role");
  if (role === "owner") throw new ApiError(400, "Ownership is transferred, not granted");

  const existingUser = await User.findOne({ email: clean });
  if (existingUser && String(workspace.owner) === String(existingUser._id)) {
    throw new ApiError(409, "That person already owns this workspace");
  }
  if (existingUser) {
    const already = await WorkspaceMember.findOne({ workspace: workspaceId, user: existingUser._id });
    if (already) throw new ApiError(409, "That person is already a member");
  } else {
    const pending = await WorkspaceMember.findOne({ workspace: workspaceId, email: clean, status: "invited" });
    if (pending) throw new ApiError(409, "That person has already been invited");
  }

  const count = await WorkspaceMember.countDocuments({
    workspace: workspaceId,
    status: { $in: ["active", "invited"] },
  });
  const limit = planFor(workspace.plan).maxMembers;
  if (count >= limit) {
    throw new ApiError(409, describeLimitBreach(workspace.plan, { members: count }) || "Seat limit reached");
  }

  const member = await WorkspaceMember.create({
    workspace: workspaceId,
    user: existingUser?._id || null,
    email: clean,
    role,
    status: existingUser ? "active" : "invited",
    invitedBy: userId,
  });

  await refreshStats(workspaceId);
  await audit.record(workspaceId, {
    action: "member.invited",
    actor: { id: userId },
    resource: { type: "user", id: existingUser?._id, name: clean },
    req,
    meta: { role, status: member.status },
  });

  return {
    id: String(member._id),
    user: member.user ? String(member.user) : null,
    email: clean,
    role: member.role,
    status: member.status,
  };
}

/**
 * Change a member's role.
 *
 * Guarded so the last owner cannot be demoted, which would leave a workspace
 * nobody can administer.
 */
export async function updateMemberRole(workspaceId, userId, { memberId, role } = {}, req) {
  const { workspace } = await authorize(workspaceId, userId, "admin");

  if (!WORKSPACE_ROLES.includes(role)) throw new ApiError(400, "Unknown role");
  if (role === "owner") throw new ApiError(400, "Ownership is transferred, not granted");

  const member = await WorkspaceMember.findOne({ _id: memberId, workspace: workspaceId });
  if (!member) throw new ApiError(404, "That member is not in this workspace");
  // Ownership moves only through transferOwnership, which is what keeps exactly one
  // owner and updates the workspace record at the same time.
  if (member.role === "owner") {
    throw new ApiError(400, "Transfer ownership instead of changing the owner's role");
  }

  const before = member.role;
  member.role = role;
  await member.save();

  await audit.record(workspaceId, {
    action: "member.role_changed",
    actor: { id: userId },
    resource: { type: "user", id: member.user, name: member.email },
    req,
    meta: { from: before, to: role },
  });

  return { id: String(member._id), role: member.role };
}

export async function removeMember(workspaceId, userId, { memberId } = {}, req) {
  const { workspace } = await authorize(workspaceId, userId, "admin");

  const member = await WorkspaceMember.findOne({ _id: memberId, workspace: workspaceId });
  if (!member) throw new ApiError(404, "That member is not in this workspace");

  if (member.role === "owner") {
    throw new ApiError(400, "The owner cannot be removed. Transfer ownership first.");
  }

  await member.deleteOne();
  await refreshStats(workspaceId);

  await audit.record(workspaceId, {
    action: "member.removed",
    actor: { id: userId },
    resource: { type: "user", id: member.user, name: member.email },
    req,
    meta: { role: member.role },
  });

  return { removed: true };
}

/** Hand ownership to another active member, keeping at least one owner behind. */
export async function transferOwnership(workspaceId, userId, { memberId } = {}, req) {
  const { workspace } = await authorize(workspaceId, userId, "owner");

  // A personal workspace belongs to the person who created it. Handing it over would
  // break the one-per-user invariant and orphan their documents.
  if (workspace.isPersonal) {
    throw new ApiError(400, "A personal workspace cannot change hands");
  }

  const target = await WorkspaceMember.findOne({ _id: memberId, workspace: workspaceId, status: "active" });
  if (!target) throw new ApiError(404, "That member is not in this workspace");
  if (!target.user) throw new ApiError(400, "That invitation has not been accepted yet");
  if (String(target.user) === String(userId)) throw new ApiError(400, "You already own this workspace");

  const currentOwner = await WorkspaceMember.findOne({ workspace: workspaceId, user: userId, role: "owner" });
  if (currentOwner) currentOwner.role = "admin";

  target.role = "owner";
  await target.save();
  if (currentOwner) await currentOwner.save();

  workspace.owner = target.user;
  await workspace.save();

  await audit.record(workspaceId, {
    action: "member.role_changed",
    actor: { id: userId },
    resource: { type: "workspace", id: workspaceId, name: workspace.name },
    req,
    meta: { transferredOwnershipTo: String(target.user) },
  });

  return { owner: String(workspace.owner) };
}

/**
 * Claim any pending invitations addressed to this user's email.
 *
 * Called after sign-in so someone who was invited before signing up lands in the
 * right workspace without a separate accept step.
 */
export async function claimInvitations(user) {
  if (!user?.email) return [];

  const pending = await WorkspaceMember.find({
    email: user.email,
    status: "invited",
    user: null,
  }).select("workspace role").lean();

  if (!pending.length) return [];

  await WorkspaceMember.updateMany(
    { _id: { $in: pending.map((p) => p._id) } },
    { $set: { user: user._id, status: "active" } }
  );

  for (const invite of pending) {
    await refreshStats(invite.workspace);
    await audit.record(invite.workspace, {
      action: "member.joined",
      actor: user,
      resource: { type: "workspace", id: invite.workspace },
    });
  }

  return pending.map((p) => ({ workspace: String(p.workspace), role: p.role }));
}

/** Leave a workspace. Owners cannot leave without transferring first. */
export async function leaveWorkspace(workspaceId, userId, req) {
  const { workspace, role } = await authorize(workspaceId, userId, "member");
  if (role === "owner") throw new ApiError(400, "Transfer ownership before leaving");
  if (workspace.isPersonal) throw new ApiError(400, "A personal workspace cannot be left");

  await WorkspaceMember.deleteOne({ workspace: workspaceId, user: userId });
  await refreshStats(workspaceId);

  await audit.record(workspaceId, {
    action: "member.removed",
    actor: { id: userId },
    resource: { type: "user", id: userId },
    req,
    meta: { self: true },
  });

  return { left: true };
}
import mongoose from "mongoose";
import * as workspaces from "../services/workspace.service.js";
import * as audit from "../services/audit.service.js";
import * as plans from "../config/plans.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Workspace HTTP layer (master plan sections 36, 46 and 49).
 *
 * Membership and role checks live in the service; these handlers only translate
 * HTTP into service calls and shape the response.
 */

/** The actor reference the audit log expects. */
function actor(req) {
  return { id: req.user.id, name: req.user.name };
}

// GET /api/v1/workspaces -> every workspace the caller belongs to
export const listMine = async (req, res) => {
  // Touching the list creates the personal workspace if it is missing, so a brand
  // new account is never left without one.
  await workspaces.ensurePersonalWorkspace(req.user);
  res.json({ workspaces: await workspaces.listForUser(req.user.id) });
};

// GET /api/v1/workspaces/plans -> the plan catalogue and the caller's current plan
export const listPlans = async (req, res) => {
  const workspace = await workspaces.ensurePersonalWorkspace(req.user);
  res.json({
    plans: plans.planCatalogue(),
    // Tells the UI whether to show an upgrade button or a "coming soon" note.
    billingEnabled: process.env.BILLING_ENABLED === "true",
    current: {
      workspace: String(workspace._id),
      plan: workspace.plan,
      limits: plans.describePlan(workspace.plan),
    },
  });
};

// POST /api/v1/workspaces -> create a team workspace
export const create = async (req, res) => {
  const workspace = await workspaces.createTeam(req.user.id, req.body || {}, req);
  res.status(201).json(workspace);
};

// GET /api/v1/workspaces/:id
export const getOne = async (req, res) => {
  const { workspace, role } = await workspaces.authorize(req.params.id, req.user.id, "viewer");
  const members = role === "viewer" ? undefined : await workspaces.listMembers(workspace._id, req.user.id);
  res.json({
    ...serialize(workspace),
    myRole: role,
    limits: plans.describePlan(workspace.plan),
    members,
  });
};

// PATCH /api/v1/workspaces/:id
export const update = async (req, res) => {
  res.json(await workspaces.updateWorkspace(req.params.id, req.user.id, req.body || {}, req));
};

// POST /api/v1/workspaces/:id/plan -> move to another plan (owner only)
export const changePlan = async (req, res) => {
  res.json(await workspaces.changePlan(req.params.id, req.user.id, req.body || {}, req));
};

// DELETE /api/v1/workspaces/:id -> move to trash
export const trash = async (req, res) => {
  res.json(await workspaces.trashWorkspace(req.params.id, req.user.id, req));
};

// POST /api/v1/workspaces/:id/restore
export const restore = async (req, res) => {
  res.json(await workspaces.restoreWorkspace(req.params.id, req.user.id, req));
};

// POST /api/v1/workspaces/:id/leave
export const leave = async (req, res) => {
  res.json(await workspaces.leaveWorkspace(req.params.id, req.user.id, req));
};

/**
 * Members
 */

// GET /api/v1/workspaces/:id/members
export const listMembers = async (req, res) => {
  res.json({ members: await workspaces.listMembers(req.params.id, req.user.id) });
};

// POST /api/v1/workspaces/:id/members -> invite by email
export const inviteMember = async (req, res) => {
  res.status(201).json(await workspaces.inviteMember(req.params.id, req.user.id, req.body || {}, req));
};

// PATCH /api/v1/workspaces/:id/members/:memberId -> change a role
export const updateMember = async (req, res) => {
  res.json(
    await workspaces.updateMemberRole(
      req.params.id,
      req.user.id,
      { memberId: req.params.memberId, ...(req.body || {}) },
      req
    )
  );
};

// DELETE /api/v1/workspaces/:id/members/:memberId
export const removeMember = async (req, res) => {
  res.json(await workspaces.removeMember(req.params.id, req.user.id, { memberId: req.params.memberId }, req));
};

// POST /api/v1/workspaces/:id/transfer -> hand ownership to a member
export const transfer = async (req, res) => {
  res.json(await workspaces.transferOwnership(req.params.id, req.user.id, req.body || {}, req));
};

/**
 * Audit log
 */

// GET /api/v1/workspaces/:id/activity
export const listActivity = async (req, res) => {
  // Admins and owners only: the log shows IPs and actions, not document content.
  await workspaces.authorize(req.params.id, req.user.id, "admin");
  audit.assertKnownAction(req.query.action);

  const page = await audit.list(req.params.id, {
    limit: req.query.limit,
    before: req.query.before,
    actor: req.query.actor || null,
    action: req.query.action || null,
  });
  res.json(page);
};

// GET /api/v1/workspaces/:id/activity/summary
export const activitySummary = async (req, res) => {
  await workspaces.authorize(req.params.id, req.user.id, "admin");
  const days = Math.min(Number(req.query.days) || 30, 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  res.json({ days, actions: await audit.summary(req.params.id, { since }) });
};

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
    createdAt: workspace.createdAt,
  };
}

/** Reject a member id that could never exist, before it reaches a query. */
export function assertMemberId(memberId) {
  if (!mongoose.isValidObjectId(memberId)) {
    throw new ApiError(400, "Invalid member id");
  }
}
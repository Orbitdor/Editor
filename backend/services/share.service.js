import Document from "../models/doc.model.js";
import User from "../models/User.model.js";
import Share, { ASSIGNABLE_ROLES } from "../models/Share.model.js";
import { ApiError } from "../utils/ApiError.js";
import {
  authorize,
  authorizeOwner,
  replaceShares,
  resolveRole,
  serializeShares,
  shareEntries,
  invalidateAccessCache,
} from "./access.service.js";
import { notifyMany } from "./notification.service.js";
import { isLiveLink, serializeLink } from "./linkshare.service.js";
import * as audit from "./audit.service.js";

/**
 * Full sharing state of a document for its owner.
 *
 * @returns {Promise<{owner: object, myRole: string, shares: Array}>}
 */
export async function getShareState(docId, userId) {
  const { doc, role } = await authorize(docId, userId, "viewer");
  const entries = await shareEntries(docId);

  const owner = await User.findById(doc.owner).select("name email").lean();
  return {
    documentId: String(docId),
    owner: owner
      ? { id: String(owner._id), name: owner.name, email: owner.email }
      : { id: String(doc.owner), name: "Unknown", email: "" },
    myRole: role,
    // Everyone with access may see who else is in. Only the owner can change
    // the list, so the dialog hides the controls for anyone else.
    shares: serializeShares(entries),
    // Whether a link exists at all is not a secret -- anyone can tell by trying --
    // but the token is only handed to the owner.
    link: role === "owner" ? serializeLink(doc.linkShare) : { enabled: isLiveLink(doc.linkShare) },
  };
}

/**
 * Add or update one person's access.
 *
 * @param {string} docId
 * @param {string} ownerId
 * @param {{email: string, role: string}} body
 */
export async function upsertShare(docId, ownerId, body) {
  const doc = await authorizeOwner(docId, ownerId);

  const role = ASSIGNABLE_ROLES.includes(body.role) ? body.role : "viewer";
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) throw new ApiError(400, "Email is required");

  const user = await User.findOne({ email });
  if (!user) throw new ApiError(404, "No account found with that email");
  if (String(user._id) === String(doc.owner)) {
    throw new ApiError(400, "The owner already has full access");
  }

  const entries = await shareEntries(docId);
  const next = entries.filter((e) => e.user !== String(user._id));
  next.push({ user: String(user._id), email: user.email, name: user.name, role });

  await replaceShares(doc, next, ownerId);

  // Tell the user they now have access, but only on a new invite.
  const wasAlreadyShared = entries.some((e) => e.user === String(user._id));
  if (!wasAlreadyShared) {
    await notifyMany([String(user._id)], {
      actor: ownerId,
      type: "share",
      document: docId,
      text: `${doc.title || "A document"} was shared with you as ${role}`,
    });
  }

  await recordSharing(doc, ownerId, "document.shared", { role, email });

  return serializeShares(await shareEntries(docId));
}

/**
 * Remove one person's access.
 */
export async function removeShare(docId, ownerId, targetUserId) {
  const doc = await authorizeOwner(docId, ownerId);
  if (String(targetUserId) === String(doc.owner)) {
    throw new ApiError(400, "The owner's access cannot be removed");
  }

  const entries = await shareEntries(docId);
  const next = entries.filter((e) => e.user !== String(targetUserId));
  if (next.length === entries.length) throw new ApiError(404, "That person is not shared on this document");

  await replaceShares(doc, next, ownerId);
  await recordSharing(doc, ownerId, "share.revoked", { user: String(targetUserId) });
  return serializeShares(await shareEntries(docId));
}

/** Note a sharing change in the workspace audit log, when there is one to log to. */
async function recordSharing(doc, actorId, action, meta) {
  if (!doc.workspace) return;
  await audit.record(doc.workspace, {
    action,
    actor: { id: actorId },
    resource: { type: "document", id: doc._id, name: doc.title },
    meta,
  });
}

/**
 * Documents that other people shared with the user.
 */
export async function listSharedWithMe(userId) {
  const shares = await Share.find({ user: userId })
    .sort("-updatedAt")
    .populate("document", "title plainText updatedAt trashedAt owner")
    .lean();

  return shares
    .filter((s) => s.document && !s.document.trashedAt)
    .map((s) => ({
      ...serializeShares([s])[0],
      document: {
        id: String(s.document._id),
        title: s.document.title,
        snippet: (s.document.plainText || "").slice(0, 140),
        updatedAt: s.document.updatedAt,
      },
    }));
}

/**
 * My effective role on a document, used by the client to set read-only mode.
 */
export async function myAccess(docId, userId) {
  const role = await resolveRole(docId, userId);
  return {
    documentId: String(docId),
    role: role || "none",
    canEdit: role === "owner" || role === "editor",
    canComment: role === "owner" || role === "editor" || role === "commenter",
    canShare: role === "owner",
  };
}

export { invalidateAccessCache };

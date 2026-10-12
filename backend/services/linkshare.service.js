import crypto from "node:crypto";
import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorizeOwner, resolveRole } from "./access.service.js";
import * as audit from "./audit.service.js";

/**
 * "Anyone with the link" access (master plan section 21).
 *
 * The design follows the same idea as the attachment signed URLs: the token is
 * the credential, it is only ever handed to the owner, and it can be withdrawn
 * by deleting it. Two rules keep that from turning into a data leak:
 *
 *  1. A link never grants more than `commenter`. `editor` over a link is a
 *     publicly writable document, which is a different and much larger promise
 *     than "here is a link to read this".
 *  2. A trashed document is not reachable by link at all, so emptying the trash
 *     is enough to withdraw a link that was already copied somewhere.
 *
 * There is deliberately no anonymous write path and no collaborative socket for a
 * link visitor: an edit-only socket cannot be authorised per-connection without a
 * session, so a link reader gets the content and nothing else.
 */

/** Roles a link may carry. Keep in step with the model enum. */
export const LINK_ROLES = ["viewer", "commenter"];

const TOKEN_BYTES = 32;

/** base64url, because the token travels in a path segment. */
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

/** Reject anything that is not exactly a token we could have minted. */
export function isLinkToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** Whether a stored linkShare block is currently usable. */
function isLive(link) {
  if (!link?.enabled || !link?.token) return false;
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

/**
 * The link state as the share dialog needs it: enough to render, and the token
 * itself so the owner can copy it.
 */
function serializeLink(link) {
  if (!isLive(link)) return { enabled: false, role: null, url: null, expiresAt: null };
  return {
    enabled: true,
    role: link.role,
    token: link.token,
    url: `/shared/${link.token}`,
    expiresAt: link.expiresAt ? new Date(link.expiresAt).toISOString() : null,
  };
}

/**
 * The link share as it appears in the owner's share state.
 */
export async function getLinkShare(docId, ownerId) {
  const doc = await authorizeOwner(docId, ownerId);
  return { documentId: String(doc._id), link: serializeLink(doc.linkShare) };
}

/**
 * Turn the link on, or change its role or expiry.
 *
 * @param {string} docId
 * @param {string} ownerId
 * @param {{role?: string, expiresInDays?: number|null, enabled?: boolean}} body
 */
export async function setLinkShare(docId, ownerId, body = {}) {
  const doc = await authorizeOwner(docId, ownerId);
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  if (body.enabled === false) return revokeLinkShare(doc, ownerId);

  const role = LINK_ROLES.includes(body.role) ? body.role : doc.linkShare?.role || "viewer";
  if (!LINK_ROLES.includes(role)) {
    throw new ApiError(400, `A link can only be ${LINK_ROLES.join(" or ")}`);
  }

  // Changing the role or the expiry keeps the same token, so a link that is
  // already in an email does not quietly stop working when the owner tidies up
  // the expiry. Turning it off and on again is what issues a new one.
  const token = doc.linkShare?.token || newToken();
  const expiresAt = parseExpiry(body.expiresInDays, doc.linkShare?.expiresAt);

  doc.linkShare = {
    enabled: true,
    token,
    role,
    expiresAt,
    createdBy: doc.linkShare?.createdBy || ownerId,
  };
  await doc.save();

  await recordLink(doc, ownerId, "document.link.enabled", { role, expiresAt });

  return { documentId: String(doc._id), link: serializeLink(doc.linkShare) };
}

/**
 * Withdraw the link. The token is cleared rather than disabled so that turning it
 * back on cannot resurrect a URL that was already circulated.
 */
export async function revokeLinkShare(docId, ownerId) {
  const doc = await authorizeOwner(docId, ownerId);

  if (doc.linkShare?.token) {
    doc.linkShare = { enabled: false, token: null, role: "viewer", expiresAt: null, createdBy: null };
    await doc.save();
    await recordLink(doc, ownerId, "document.link.revoked", {});
  }

  return { documentId: String(doc._id), link: serializeLink(doc.linkShare) };
}

/** `null` means no expiry; a number is that many days from now. */
function parseExpiry(expiresInDays, previous) {
  if (expiresInDays === null || expiresInDays === "") return null;
  if (expiresInDays === undefined) return previous || null;
  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new ApiError(400, "Expiry must be between 1 and 365 days");
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Read a document through its link, with no session at all.
 *
 * @param {string} token
 * @returns {Promise<{doc: object, role: string}>}
 */
export async function openByLink(token) {
  if (!isLinkToken(token)) throw new ApiError(404, "This link is not valid");

  const doc = await Document.findOne({ "linkShare.token": token }).select(
    "+linkShare.token title content plainText owner updatedAt createdAt trashedAt linkShare"
  );
  if (!doc) throw new ApiError(404, "This link is not valid");

  if (doc.trashedAt) {
    throw new ApiError(410, "This document is in the trash, so its link is closed");
  }
  if (!isLive(doc.linkShare)) throw new ApiError(410, "This link has been turned off");

  return { doc, role: doc.linkShare.role };
}

/**
 * The document as a link visitor may see it.
 *
 * Deliberately not the authenticated shape: no workspace id, no folder, no owner
 * email, no collaboration state, and no versions. A link shares the document, not
 * the account that holds it.
 */
export function serializeLinkDocument(doc, role) {
  return {
    id: String(doc._id),
    title: doc.title || "Untitled",
    content: doc.content || "",
    // The link grants at most commenter, and commenting needs an identity, so
    // the honest answer is that a link visitor cannot comment yet.
    role,
    canEdit: false,
    canComment: false,
    viaLink: true,
    sharedBy: String(doc.owner),
    updatedAt: doc.updatedAt,
  };
}

/**
 * Whether `userId` already has a stronger role than the link offers, so the
 * client can treat a signed-in link visit as a normal visit.
 */
export async function linkIsRedundant(doc, userId) {
  if (!userId) return false;
  const role = await resolveRole(doc._id, userId, doc);
  return role === "owner" || role === "editor" || role === "commenter";
}

async function recordLink(doc, actorId, action, meta) {
  if (!doc.workspace) return;
  await audit.record(doc.workspace, {
    action,
    actor: { id: actorId },
    resource: { type: "document", id: doc._id, name: doc.title },
    meta,
  });
}

export { serializeLink, isLive as isLiveLink };

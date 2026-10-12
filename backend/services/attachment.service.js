import crypto from "node:crypto";
import mongoose from "mongoose";
import Attachment from "../models/Attachment.model.js";
import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorize, authorizeEdit, resolveRole } from "./access.service.js";
import { getWorkspace, refreshStats } from "./workspace.service.js";
import { describeLimitBreach, planFor } from "../config/plans.js";
import { isImageMime, storageConfig } from "../config/storage.js";
import { safeFilename, storage, validate as validateUpload } from "./storage.service.js";
import { openByLink } from "./linkshare.service.js";
import * as audit from "./audit.service.js";

/**
 * Attachments for a document (master plan section 27).
 *
 * Two decisions shape this file.
 *
 * First, an attachment is authorised through its document, never on its own. The
 * document already resolves owner, explicit share and workspace membership into
 * one role; reusing that means a file cannot be more or less visible than the
 * page it sits on, and there is no second permission model to keep in sync.
 *
 * Second, storage quota is checked before the bytes are written, not after. Being
 * told "your workspace is full" after a 20 MB upload has already crossed the
 * network is a bad way to learn that.
 */

const DIMENSIONS = { width: null, height: null };

/** png, jpeg, gif and webp headers all carry their dimensions; read them. */
function readImageDimensions(buffer, mime) {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      // Walk the segment list to the first start-of-frame marker.
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (mime === "image/webp" && buffer.length >= 30) {
      const format = buffer.subarray(12, 16).toString("ascii");
      if (format === "VP8 ") {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (format === "VP8X") {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
      }
    }
  } catch {
    // Dimensions are a convenience for layout, not a security property. A header
    // we cannot parse must not fail an otherwise valid upload.
  }
  return DIMENSIONS;
}

/** Bytes already stored in a workspace, from the metadata rows. */
async function storedBytes(workspaceId) {
  const rows = await Attachment.aggregate([
    { $match: { workspace: workspaceId } },
    { $group: { _id: null, bytes: { $sum: "$bytes" } } },
  ]);
  return rows[0]?.bytes || 0;
}

/**
 * Refuse the upload if it would push the workspace past its plan's storage
 * allowance. `describeLimitBreach` phrases the refusal per plan, so it is given
 * the total this upload *would* reach rather than the total today: the plan
 * module tests `used >= limit`, which is never true at the moment we refuse.
 */
async function assertStorageRoom(workspaceId, plan, incoming) {
  const used = await storedBytes(workspaceId);
  const projected = used + incoming;
  if (projected >= plan.storageBytes) {
    throw new ApiError(
      409,
      describeLimitBreach(plan, { storageBytes: projected }) || "Storage limit reached"
    );
  }
}

/** Metadata for a document, newest first. Anyone who can see the page can list them. */
export async function list(documentId, userId) {
  await authorize(documentId, userId, "viewer");
  const rows = await Attachment.find({ document: documentId }).sort({ createdAt: 1 }).lean();
  return rows.map(serialize);
}

export async function stats(documentId, userId) {
  await authorize(documentId, userId, "viewer");
  const rows = await Attachment.aggregate([
    // Aggregation does not cast, so the id has to arrive as an ObjectId or the
    // match silently compares a string against ObjectIds and finds nothing.
    { $match: { document: new mongoose.Types.ObjectId(String(documentId)) } },
    { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$bytes" } } },
  ]);
  return { count: rows[0]?.count || 0, bytes: rows[0]?.bytes || 0 };
}

/**
 * Attach an uploaded file to a document.
 *
 * `file` is a multer memory-storage object: `{ buffer, originalname, mimetype }`.
 * Buffer rather than disk, because the size and type checks have to run before
 * anything is written anywhere.
 */
export async function attach(documentId, userId, file, req) {
  if (!file?.buffer?.length) throw new ApiError(400, "No file was received");
  await authorizeEdit(documentId, userId);

  const doc = await Document.findById(documentId).select("_id workspace").lean();
  if (!doc) throw new ApiError(404, "Document not found");

const workspace = await getWorkspace(doc.workspace);
  if (!workspace) throw new ApiError(404, "Workspace not found");

  const mime = String(file.mimetype || "").split(";")[0].trim().toLowerCase();

  // Type and content are checked before the quota is consulted: both are local
  // and cheap, and a file that was never going to be kept should not cost a
  // database round trip.
  validateUpload(file.buffer, mime);

  const plan = planFor(workspace.plan);
  await assertStorageRoom(doc.workspace, plan, file.buffer.length);

  const saved = await storage.save({
    buffer: file.buffer,
    mime,
    filename: file.originalname,
    kind: mime.startsWith("audio/") ? "audio" : isImageMime(mime) ? "image" : "file",
    workspaceId: doc.workspace,
  });

  const { width, height } = isImageMime(mime)
    ? readImageDimensions(file.buffer, mime)
    : DIMENSIONS;

  try {
    const created = await Attachment.create({
      document: documentId,
      workspace: doc.workspace,
      uploadedBy: userId,
      name: safeFilename(file.originalname),
      mime: saved.mime,
      bytes: saved.bytes,
      kind: isImageMime(mime) ? "image" : mime.startsWith("audio/") ? "audio" : "file",
      storageKey: saved.key,
      sha256: saved.sha256,
      width,
      height,
    });
    // The cached total feeds the workspace dashboard, so keep it honest.
    await refreshStats(doc.workspace).catch(() => null);
    await recordEvent(workspace._id, userId, "document.attachment_added", created);
    return serialize(created.toObject());
  } catch (err) {
    // The metadata row is the only thing that makes the bytes findable, so if it
    // failed the upload must not be left behind on disk.
    await storage.remove(saved.key).catch(() => null);
    throw err;
  }
}

/** Read an attachment's bytes, after checking the caller may see its document. */
export async function read(attachmentId, userId) {
  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, "Attachment not found");
  await authorize(String(attachment.document), userId, "viewer");

  let buffer;
  try {
    buffer = await storage.read(attachment.storageKey);
  } catch {
    // The row survived but the bytes did not, which is a real operational state:
    // say so plainly instead of returning an empty file.
    throw new ApiError(410, "This file is no longer available");
  }
  return { attachment, buffer };
}

/**
 * Read an attachment on behalf of a link visitor.
 *
 * The link authorises the document, but only for attachments that belong to that
 * same document. Checking both is what stops a valid link from becoming a way to
 * walk every attachment id in the database.
 */
export async function readViaLink(attachmentId, token) {
  const { doc, role } = await openByLink(token);

  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, "Attachment not found");
  if (String(attachment.document) !== String(doc._id)) {
    // Not a 404 by accident: a wrong document means the caller guessed an id, and
    // saying so would confirm the attachment exists.
    throw new ApiError(404, "Attachment not found");
  }

  let buffer;
  try {
    buffer = await storage.read(attachment.storageKey);
  } catch {
    throw new ApiError(410, "This file is no longer available");
  }
  return { attachment, buffer, role };
}

/** Remove an attachment and its bytes. Editors may; so may the person who uploaded it. */
export async function remove(attachmentId, userId) {
  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, "Attachment not found");

  const role = await resolveRole(String(attachment.document), userId);
  const isUploader = String(attachment.uploadedBy) === String(userId);
  if (role !== "owner" && !isUploader) {
    // Fall back to the document permission check for a proper 403.
    await authorizeEdit(String(attachment.document), userId);
  }

  await storage.remove(attachment.storageKey).catch(() => null);
  await Attachment.deleteOne({ _id: attachmentId });
  await refreshStats(attachment.workspace).catch(() => null);

  const workspace = await getWorkspace(attachment.workspace);
  if (workspace) {
    await recordEvent(attachment.workspace, userId, "document.attachment_removed", attachment);
  }
}

/* ------------------------------------------------------------------ *
 * Signed download URLs (section 37)
 * ------------------------------------------------------------------ */

/**
 * A short-lived signature over the attachment id and expiry.
 *
 * With object storage this would be a provider presigned URL. The local provider
 * has no presigner, so the signature is minted here and the same expiring URL is
 * served by `GET /attachments/:id/signed`.
 */
export function signAttachment(attachmentId, expiresAt, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${attachmentId}.${expiresAt}`)
    .digest("hex");
}

export function signedUrlFor(attachment, ttlSeconds, secret) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const signature = signAttachment(String(attachment._id), expiresAt, secret);
  return {
    url: `/api/v1/attachments/${attachment._id}/signed?expires=${expiresAt}&signature=${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Resolve a signed link to its bytes.
 *
 * The signature is the credential, exactly as it is for a provider presigned URL:
 * that is what makes the link usable from an `<img>` tag or a download link that
 * never carries our session cookie. The protection it relies on is that the
 * window is short (15 minutes by default) and the link is handed out deliberately,
 * never embedded in shared markup.
 */
export async function signed(attachmentId, query, secret) {
  const expires = Number(query.expires);
  const signature = String(query.signature || "");
  if (!expires || !signature) throw new ApiError(401, "This link is not valid");
  if (Number.isNaN(expires) || expires < Date.now()) {
    throw new ApiError(401, "This link has expired");
  }
  const expected = signAttachment(String(attachmentId), expires, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch, and a wrong-length
  // signature should fail the same quiet way.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(401, "This link is not valid");
  }

  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, "Attachment not found");

  let buffer;
  try {
    buffer = await storage.read(attachment.storageKey);
  } catch {
    throw new ApiError(410, "This file is no longer available");
  }
  return { attachment, buffer };
}

/** Hand a caller a fresh signed link. Minting one requires normal document access. */
export async function mintSigned(attachmentId, userId, secret) {
  const attachment = await Attachment.findById(attachmentId);
  if (!attachment) throw new ApiError(404, "Attachment not found");
  await authorize(String(attachment.document), userId, "viewer");
  return signedUrlFor(attachment, storageConfig().signedUrlTtlSeconds, secret);
}

/**
 * Drop every attachment of a document, bytes included.
 *
 * Called when a document is permanently deleted. The metadata rows would go with
 * the document's cascade anyway, but the files live outside Mongo, so nothing
 * else would ever reclaim them.
 */
export async function purgeDocument(documentId) {
  const rows = await Attachment.find({ document: documentId }).select("_id storageKey workspace").lean();
  if (!rows.length) return { removed: 0 };

  await Promise.all(rows.map((row) => storage.remove(row.storageKey).catch(() => null)));
  const result = await Attachment.deleteMany({ document: documentId });

  // The workspace total included these bytes.
  const workspaces = [...new Set(rows.map((r) => String(r.workspace)))];
  await Promise.all(workspaces.map((id) => refreshStats(id).catch(() => null)));
  return { removed: result.deletedCount };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function serialize(row) {
  return {
    _id: row._id,
    document: row.document,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    kind: row.kind,
    width: row.width,
    height: row.height,
    isImage: row.kind === "image",
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

/**
 * Audit entry. An unrecognised action is skipped rather than invented: an audit
 * log that makes up event names is worse than one that stays quiet.
 */
async function recordEvent(workspaceId, userId, action, attachment) {
  if (!audit.assertKnownAction(action)) return;
  await audit.record(workspaceId, {
    action,
    actor: { id: userId },
    resource: { type: "attachment", id: attachment._id, name: attachment.name },
  });
}
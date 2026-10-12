import * as attachments from "../services/attachment.service.js";
import { storageConfig, INLINE_IMAGE_TYPES } from "../config/storage.js";

/**
 * Attachment HTTP layer (master plan section 27, route table in section 38).
 *
 * The service owns permissions, quota and validation. This layer's own
 * responsibilities are narrow: deciding how bytes leave the building, and never
 * letting a browser treat a stored file as same-origin active content.
 */

/**
 * Send a stored file to the browser.
 *
 * `Content-Disposition: attachment` is the default because it is the safe one: it
 * downloads rather than renders, so an uploaded PDF or SVG cannot execute in our
 * origin. Inline is allowed only for image types the editor renders itself, and
 * even then `X-Content-Type-Options: nosniff` stops the browser from guessing
 * something else. Section 37 asks for both of these by name.
 */
function sendFile(res, attachment, buffer, { download = true } = {}) {
  const cfg = storageConfig();
  const inline = !download && !cfg.forceDownload && attachment.kind === "image";
  // The one class of type a stored file may never be served as.
  res.setHeader("Content-Type", inline ? attachment.mime : "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  const name = attachment.name.replace(/["\\]/g, "_");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  return res.send(buffer);
}

export const ListAttachments = async (req, res) => {
  const rows = await attachments.list(req.params.documentId, req.user.id);
  res.json({ attachments: rows });
};

export const AttachmentStats = async (req, res) => {
  res.json({ stats: await attachments.stats(req.params.documentId, req.user.id) });
};

/**
 * The document an upload belongs to.
 *
 * The document-scoped routes carry it in the path; the `/api/v1/uploads` alias
 * carries it in the multipart body instead, because that is the shape the route
 * table in section 38 specifies. Reading only the path would make the alias fail
 * on every call.
 */
const documentIdOf = (req) => req.params?.documentId || req.body?.documentId;

export const UploadAttachment = async (req, res) => {
  const created = await attachments.attach(documentIdOf(req), req.user.id, req.file, req);
  res.status(201).json({ attachment: created });
};

/**
 * Upload that also returns an inline URL. The editor needs somewhere to point an
 * `<img>` at immediately, and the same route would otherwise need a second call.
 */
export const UploadImage = async (req, res) => {
  const created = await attachments.attach(documentIdOf(req), req.user.id, req.file, req);
  res.status(201).json({
    attachment: created,
    url: `/api/v1/attachments/${created._id}/content?inline=1`,
  });
};

export const DownloadAttachment = async (req, res) => {
  const { attachment, buffer } = await attachments.read(req.params.id, req.user.id);
  // Only an explicit `inline=1` on an image renders; everything else downloads.
  const download = !(req.query.inline === "1" && attachment.kind === "image");
  sendFile(res, attachment, buffer, { download });
};

/** Mint a fresh signed link. See `attachment.service.js` for why it expires. */
export const MintSignedUrl = async (req, res) => {
  const { url, expiresAt } = await attachments.mintSigned(
    req.params.id,
    req.user.id,
    req.app.locals.jwtSecret
  );
  res.json({ url, expiresAt });
};

/** Serve a file through a previously minted signed link. */
export const ServeSigned = async (req, res) => {
  const { attachment, buffer } = await attachments.signed(
    req.params.id,
    req.query,
    req.app.locals.jwtSecret
  );
  sendFile(res, attachment, buffer, { download: req.query.inline !== "1" });
};

export const DeleteAttachment = async (req, res) => {
  await attachments.remove(req.params.id, req.user.id);
  res.json({ ok: true });
};

/**
 * Editor capability probe, so the toolbar knows which formats the attach button
 * will accept before the user picks something doomed.
 */
export const AttachmentCapabilities = async (_req, res) => {
  const cfg = storageConfig();
  res.json({
    provider: cfg.provider,
    maxBytes: cfg.maxBytes,
    maxImageBytes: cfg.maxImageBytes,
    allowedMimeTypes: Object.keys(cfg.allowedMimeTypes),
    inlineImageTypes: [...INLINE_IMAGE_TYPES],
  });
};

export { sendFile };
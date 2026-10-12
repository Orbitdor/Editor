/**
 * File attachment storage configuration (master plan sections 27, 37 and 45).
 *
 * Section 45 is explicit that large files must not live in MongoDB: the bytes go
 * to object storage and Mongo keeps only metadata. This config is the seam for
 * that. The default provider writes to local disk, which is correct for a single
 * VPS and for the test suite; swapping in S3, Cloudinary or anything else is a
 * provider behind `storage.service.js`, with no change to any caller.
 *
 * Everything hostile about an upload is decided here rather than in the
 * controller, so there is exactly one list to audit.
 */

/** Read a value from several possible env var names. */
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
};

/**
 * Allowed types, from the plan's list: "PDF, DOCX, XLSX, PPTX, Images, ZIP".
 * A type is only accepted if it is both in this allow-list and passes the magic
 * byte check in `storage.service.js`, because a `.png` that is really a script
 * would otherwise sail through on its extension alone.
 */
export const ALLOWED_MIME_TYPES = {
  // Images are the ones the editor can render inline.
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  // Documents people actually attach to a proposal.
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "text/plain": "txt",
  "text/csv": "csv",
  // Audio, shared with the voice pipeline.
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "weba",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  // Archives.
  "application/zip": "zip",
};

/**
 * SVG is deliberately absent from the inline-image set below. An SVG is a script
 * container, and serving one from our own origin would let an uploaded file run
 * in the app's session. It can still be attached and downloaded, but the editor
 * will never render it inline.
 */
export const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Magic byte prefixes, used to confirm a file really is what its name claims.
 * A mismatch is a rejection rather than a warning: this is the only check that
 * survives a client that lies about its content type.
 */
export const MAGIC_BYTES = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
];

/** Everything the OOXML formats share: a zip container. */
export const ZIP_BASED_MIME_TYPES = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function storageConfig() {
  const maxBytes = Number(pick("UPLOAD_MAX_BYTES")) || 20 * 1024 * 1024;
  return {
    provider: (pick("STORAGE_PROVIDER") || "local").toLowerCase(),
    /** Where the local provider writes. Outside the repo, so a build cannot eat it. */
    root: pick("STORAGE_ROOT") || "./.uploads",
    /** How long a signed download link stays valid. */
    signedUrlTtlSeconds: Number(pick("STORAGE_SIGNED_TTL")) || 900,
    maxBytes,
    // A plan's storage quota is enforced per workspace, so this is only the
    // per-file ceiling that stops one enormous request.
    maxImageBytes: Number(pick("UPLOAD_MAX_IMAGE_BYTES")) || 8 * 1024 * 1024,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
/**
     * Escape hatch, not the default: forces every stored file to be served as a
     * download. The allow-list plus the magic byte check plus the decision to
     * never render SVG inline are what make a normal upload safe, so this only
     * needs turning on for an operator who wants a blanket download policy.
     */
    forceDownload: (pick("UPLOAD_FORCE_DOWNLOAD") || "false").toLowerCase() === "true",
  };
}

export function isImageMime(mime) {
  return INLINE_IMAGE_TYPES.has(mime);
}

/** Capability snapshot, so the editor knows what the attach button accepts. */
export function storageStatus(cfg = storageConfig()) {
  return {
    provider: cfg.provider,
    maxBytes: cfg.maxBytes,
    maxImageBytes: cfg.maxImageBytes,
    maxImageEdge: 1600,
    allowedMimeTypes: Object.keys(cfg.allowedMimeTypes),
    inlineImageTypes: [...INLINE_IMAGE_TYPES],
  };
}
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";
import { storageConfig } from "../config/storage.js";

/**
 * Multipart handling for attachments (master plan section 27).
 *
 * Memory storage, deliberately. The size cap, the type allow-list and the magic
 * byte check all have to run before anything is written anywhere, and the service
 * layer is where that logic lives. Buffering a single bounded file is cheaper to
 * reason about than streaming an unbounded one to disk and cleaning up after it.
 *
 * `fileSize` here is only the outermost guard that keeps a hostile request from
 * exhausting memory; `storage.service.js` enforces the same ceiling again before
 * storing.
 */

const cfg = storageConfig();

export const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: cfg.maxImageBytes,
    // One file per request: an editor inserts one attachment at a time.
    files: 1,
    fields: 10,
  },
  fileFilter(_req, file, cb) {
    // A cheap pre-filter. The authoritative check is the magic byte comparison in
    // `storage.service.js`, because this one only sees what the client claimed.
    const mime = String(file.mimetype || "").toLowerCase();
    if (!mime.startsWith("image/")) {
      cb(new ApiError(415, "Only image files can be uploaded here"));
      return;
    }
    cb(null, true);
  },
}).single("file");

export const uploadSingleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cfg.maxBytes, files: 1, fields: 10 },
}).single("file");

/**
 * Translate multer's own limit errors into the same shape as everything else, so
 * a client sees one error format whether the rejection came from us or from the
 * multipart parser.
 */
export function uploadErrorHandler(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      next(new ApiError(413, `That file is larger than the ${Math.round(cfg.maxBytes / (1024 * 1024))} MB limit`));
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      next(new ApiError(400, "Send one file at a time, in the `file` field"));
      return;
    }
    next(new ApiError(400, "That upload could not be read"));
    return;
  }
  next(err);
}
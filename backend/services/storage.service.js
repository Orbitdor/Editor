import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { connectDB } from "../config/db.js";
import {
  MAGIC_BYTES,
  ZIP_BASED_MIME_TYPES,
  isImageMime,
  storageConfig,
} from "../config/storage.js";

/**
 * Object storage for attachments (master plan section 45).
 *
 * Every provider implements the same four operations, so the rest of the app
 * never asks where bytes live:
 *   - `put`     store a buffer, return the key
 *   - `get`     read a buffer
 *   - `delete`  remove it
 *   - `signed`  a time-limited URL for a browser to fetch
 *
 * `local` is the default because a single VPS is the stated deployment target
 * and it lets the suite run with no external service. The layout mirrors the
 * plan's tree exactly: uploads/{documents,images,avatars,audio,exports}/.
 */

/** Which bucket a file belongs in, derived from its type rather than its name. */
function bucketFor(mime, kind) {
  if (kind === "audio" || String(mime).startsWith("audio/")) return "audio";
  if (kind === "image" || isImageMime(mime)) return "images";
  return "documents";
}

/**
 * A key that reveals nothing and cannot collide: a random id, then a sanitised
 * extension. The original filename is kept in Mongo, never in the path, so a
 * name like `../../etc/passwd` has nowhere to go.
 */
function buildKey({ workspaceId, mime, kind, ext }) {
  const id = crypto.randomBytes(16).toString("hex");
  const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
  return `${bucketFor(mime, kind)}/${workspaceId || "unscoped"}/${stamp}/${id}.${ext}`;
}

const localProvider = {
  name: "local",

  async resolveRoot() {
    const { root } = storageConfig();
    return path.resolve(process.cwd(), root);
  },

  async put(key, buffer) {
    const full = path.join(await this.resolveRoot(), key);
    // `key` is generated above, but the containment check makes that assumption
    // explicit rather than implied: nothing outside the root is ever writable.
    if (!full.startsWith(await this.resolveRoot())) {
      throw new ApiError(400, "Refusing to write outside the storage root");
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return key;
  },

  async get(key) {
    const full = path.join(await this.resolveRoot(), key);
    return fs.readFile(full);
  },

  async delete(key) {
    const full = path.join(await this.resolveRoot(), key);
    await fs.unlink(full).catch(() => null);
  },

  /**
   * On local disk a signed URL is a signed API route, because handing out a raw
   * filesystem path would let anyone who guesses a key read the file. The
   * signature is minted in `attachment.service.js`, which knows the route.
   */
  async signed() {
    return null;
  },
};

/**
 * GridFS-backed provider, for hosts whose filesystem does not survive a request
 * (serverless functions such as Vercel). Bytes are chunked into the same MongoDB
 * the app already uses, so a file larger than the 16 MB document limit is safe.
 * Selected with STORAGE_PROVIDER=mongo.
 */
const gridFsProvider = {
  name: "mongo",

  async bucket() {
    // The connection is established lazily because a cold serverless invocation
    // may serve this call before the module-level connect has resolved.
    if (mongoose.connection.readyState !== 1) await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new ApiError(503, "Storage is not available yet");
    return new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });
  },

  async put(key, buffer) {
    const bucket = await this.bucket();
    await new Promise((resolve, reject) => {
      const stream = bucket.openUploadStream(key);
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(buffer);
    });
    return key;
  },

  async get(key) {
    const bucket = await this.bucket();
    const file = await bucket.find({ filename: key }).limit(1).next();
    if (!file) throw new ApiError(404, "That file is no longer available");
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = bucket.openDownloadStream(file._id);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  },

  async delete(key) {
    const bucket = await this.bucket();
    const files = await bucket.find({ filename: key }).toArray();
    await Promise.all(files.map((f) => bucket.delete(f._id).catch(() => null)));
  },

  async signed() {
    return null;
  },
};

const providers = { local: localProvider, mongo: gridFsProvider };

function provider() {
  const { provider: name } = storageConfig();
  const found = providers[name];
  if (!found) {
    // A misconfigured provider must fail loudly rather than silently writing
    // somewhere nobody will look.
    throw new ApiError(500, `Unknown storage provider "${name}"`);
  }
  return found;
}

/**
 * Confirm the bytes match the claimed type.
 *
 * Browsers are inconsistent about the content type they send, and a determined
 * uploader will simply declare `image/png` for anything. For the formats with a
 * known signature this compares magic bytes; for zip-based OOXML the shared zip
 * header is all there is to check without opening the archive.
 */
function verifyContent(buffer, mime) {
  if (!buffer.length) throw new ApiError(400, "The file is empty");

  const claim = MAGIC_BYTES.find((m) => m.mime === mime);
  if (claim) {
    const ok = claim.bytes.every((b, i) => buffer[i] === b);
    if (!ok) {
      throw new ApiError(400, "That file's contents do not match its file type");
    }
    return;
  }

  if (ZIP_BASED_MIME_TYPES.has(mime)) {
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (!isZip) {
      throw new ApiError(400, "That file's contents do not match its file type");
    }
    return;
  }

  if (isImageMime(mime)) {
    // webp and svg have no entry above; a webp is "RIFF....WEBP" and an SVG is
    // text, so both get a cheap shape check rather than being waved through.
    if (mime === "image/webp") {
      const riff = buffer.subarray(0, 4).toString("ascii") === "RIFF";
      const webp = buffer.subarray(8, 12).toString("ascii") === "WEBP";
      if (!riff || !webp) throw new ApiError(400, "That file's contents do not match its file type");
      return;
    }
    if (mime === "image/svg+xml") {
      const head = buffer.subarray(0, 512).toString("utf8").trimStart();
      if (!head.startsWith("<")) {
        throw new ApiError(400, "That file's contents do not match its file type");
      }
      return;
    }
  }

  // Text formats: reject a NUL byte, which no text file contains but every
  // binary blob does. This is what stops a renamed executable arriving as .txt.
  if (mime.startsWith("text/") || mime === "image/svg+xml") {
    if (buffer.subarray(0, 4096).includes(0)) {
      throw new ApiError(400, "That file's contents do not match its file type");
    }
  }
}

/** Confirm the bytes match the claimed type, and that the type is allowed at all. */
export function validate(buffer, mime) {
  const cfg = storageConfig();
  const cleanMime = String(mime || "").split(";")[0].trim().toLowerCase();
  const ext = cfg.allowedMimeTypes[cleanMime];
  if (!ext) throw new ApiError(415, "That file type is not supported");
  if (buffer.length > cfg.maxBytes) {
    const mb = Math.round(cfg.maxBytes / (1024 * 1024));
    throw new ApiError(413, `Files must be under ${mb} MB`);
  }
  if (!buffer.length) throw new ApiError(400, "The file is empty");
  verifyContent(buffer, cleanMime);
  return { mime: cleanMime, ext };
}

export const storage = {
  name: () => provider().name,

  /**
   * Validate and store one upload. Returns the key plus the digest and byte
   * count the metadata row records.
   */
  async save({ buffer, mime, filename, kind = null, workspaceId = null }) {
    const { mime: cleanMime, ext } = validate(buffer, mime);

    const key = buildKey({ workspaceId, mime: cleanMime, kind, ext });
    await provider().put(key, buffer);

    return {
      key,
      mime: cleanMime,
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  },

  async read(key) {
    return provider().get(key);
  },

  async remove(key) {
    return provider().delete(key);
  },
};

/**
 * A name safe to show and to put in a `Content-Disposition` header: no path
 * separators, no control characters, bounded length.
 */
export function safeFilename(name) {
  const base = String(name || "file")
    .replace(/[\\/]+/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return base || "file";
}

export { verifyContent, bucketFor };
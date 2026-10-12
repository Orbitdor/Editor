import crypto from "node:crypto";

/**
 * Encryption for third-party credentials at rest.
 *
 * A Google refresh token is effectively a password for the user's Drive: anyone
 * holding it can read and write their files. MongoDB may be backed up, snapshotted
 * or queried by an operator, so the token is stored as ciphertext rather than
 * plaintext.
 *
 * AES-256-GCM is authenticated encryption, so a tampered row fails to decrypt
 * instead of returning garbage. The key is derived from `TOKEN_ENCRYPTION_KEY`
 * with scrypt, which means a short or human-typed passphrase still yields a
 * full-strength key.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = "v1";

/** Cached derived key, so scrypt does not run on every read. */
let cachedKey = null;
let cachedMaterial = null;

function deriveKey() {
  const material =
    process.env.TOKEN_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    // A hard fallback keeps development working; production must set a real key,
    // which `isEncryptionConfigured` reports on.
    "dev-only-insecure-token-key";

  if (cachedKey && cachedMaterial === material) return cachedKey;

  // A stable salt keeps the derived key constant across restarts, which is what
  // lets already-stored tokens keep decrypting. A per-record salt would require
  // storing it alongside each row, which this format does not do.
  const salt = process.env.TOKEN_ENCRYPTION_SALT || "doc-editor-token-salt-v1";
  cachedKey = crypto.scryptSync(material, salt, KEY_BYTES);
  cachedMaterial = material;
  return cachedKey;
}

/** True when a real encryption key is configured rather than the dev fallback. */
export function isEncryptionConfigured() {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Encrypt a secret for storage.
 *
 * @param {string} plaintext
 * @returns {string} `v1:<iv>:<tag>:<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a stored secret.
 *
 * Returns null rather than throwing when the value is unreadable: a token that
 * was encrypted under a rotated key, or hand-edited in the database, should
 * force the user to reconnect instead of crashing the request.
 *
 * @param {string} stored
 * @returns {string|null}
 */
export function decryptSecret(stored) {
  if (!stored) return null;
  const parts = String(stored).split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const [, iv, tag, ciphertext] = parts;
    const decipher = crypto.createDecipheriv(ALGO, deriveKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Short, non-reversible fingerprint of a token, safe to log. Lets support see
 * which token is in use without ever exposing it.
 *
 * @param {string} stored
 * @returns {string|null}
 */
export function secretFingerprint(stored) {
  if (!stored) return null;
  return crypto.createHash("sha256").update(String(stored)).digest("hex").slice(0, 12);
}

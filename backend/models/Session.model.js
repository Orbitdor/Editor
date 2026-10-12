import mongoose from "mongoose";
import crypto from "node:crypto";

/**
 * One row per signed-in device (master plan section 8: "session management" and
 * "logout all devices").
 *
 * The refresh token itself is never stored. Only a SHA-256 digest of it is, so a
 * database leak cannot be replayed as a login. Because every refresh mints a new
 * token and records the successor, an already-used token is detectable: it is
 * revoked, and so is every session descended from it. That is what makes replay
 * detection possible instead of merely unlikely.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** SHA-256 of the live refresh token, hex encoded. */
    tokenHash: { type: String, required: true, index: true, unique: true },
    /** The session that issued this one, so a stolen-then-used chain can be cut. */
    rotatedFrom: { type: String, default: null, index: true },
    /** Everything here is display-only, for the "your devices" screen. */
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    /** Set when the user signs out one device or all devices. */
    revokedAt: { type: Date, default: null, index: true },
    lastUsedAt: { type: Date, default: null },
    /** Backs the TTL index below: Mongo reaps the row 30 days after this date. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Mongo expires the document itself 30 days after creation, so an abandoned
// device needs no sweeper job.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Digest of a raw refresh token. Tolerates a missing cookie: the caller may be
 *  carrying only the access cookie, and hashing `null` would throw. */
export function hashToken(raw) {
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const Session = mongoose.model("Session", sessionSchema);
export default Session;
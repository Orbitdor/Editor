import mongoose from "mongoose";

/**
 * Short-lived OAuth handshake records (master plan section 29).
 *
 * The authorization-code flow is split across two separate HTTP requests — the
 * redirect to Google and the callback from it — so the `state` value that ties
 * them together has to survive between them. The same is true of the single-use
 * ticket that carries a finished session back to the frontend.
 *
 * Holding these in process memory only works on a single long-lived instance.
 * A serverless host (Vercel functions) may answer the two halves with different
 * instances, which would make every sign-in fail with "link expired". They are
 * therefore stored in MongoDB with a TTL index, and consumed with an atomic
 * delete so a value stays single-use.
 */
const oauthStateSchema = new mongoose.Schema(
  {
    /** The random nonce handed to Google (or the browser), used as the key. */
    _id: { type: String },
    kind: { type: String, enum: ["state", "ticket"], required: true },
    /** "auth" for sign-in, "connect" for the Drive/Docs grant. */
    flow: { type: String, enum: ["auth", "connect", null], default: null },
    returnTo: { type: String, default: "/" },
    /** Scope groups requested by a connect flow. */
    groups: { type: [String], default: undefined },
    userId: { type: String, default: null },
    /** The finished session a ticket redeems into. */
    session: { type: mongoose.Schema.Types.Mixed, default: null },
    /** TTL: MongoDB drops the row once this passes. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// The row is deleted when it is consumed; this only sweeps up values that were
// issued but never used.
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("OAuthState", oauthStateSchema);

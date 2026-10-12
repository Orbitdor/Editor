import mongoose from "mongoose";
import { decryptSecret, encryptSecret, secretFingerprint } from "../services/tokenVault.js";

/**
 * A user's connection to a third-party service (master plan section 29).
 *
 * One row per user per provider. The refresh token is the crown jewel here: it
 * grants ongoing access to the user's Drive or Docs without them re-consenting,
 * so it is encrypted at rest (see `tokenVault`) and never returned by any
 * endpoint. The plain access token is deliberately not persisted at all, since
 * it is short-lived and can be re-derived from the refresh token.
 */
const googleConnectionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: { type: String, enum: ["google"], default: "google" },
    /** Google account this is connected to, which is not necessarily the app account. */
    googleUserId: { type: String, default: null },
    email: { type: String, default: null, lowercase: true, trim: true },
    displayName: { type: String, default: null },
    /** Encrypted refresh token, see `tokenVault`. */
    refreshToken: { type: String, default: null },
    /** Non-reversible fingerprint, so support can identify a token safely. */
    tokenHint: { type: String, default: null },
    /** Scope groups the user actually granted, e.g. `["drive", "docs"]`. */
    groups: { type: String, default: "", index: true },
    /** Raw scope strings Google reported back, for auditing. */
    scopes: { type: String, default: "" },
    /** When the last successful call succeeded; a stale value signals rotation. */
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One connection per user per provider.
googleConnectionSchema.index({ user: 1, provider: 1 }, { unique: true });

googleConnectionSchema.virtual("groupList").get(function groupList() {
  return this.groups ? this.groups.split(" ").filter(Boolean) : [];
});

googleConnectionSchema.virtual("scopeList").get(function scopeList() {
  return this.scopes ? this.scopes.split(" ").filter(Boolean) : [];
});

/** Store a refresh token, encrypted, keeping the fingerprint in step. */
googleConnectionSchema.methods.setRefreshToken = function setRefreshToken(token) {
  if (!token) return;
  this.refreshToken = encryptSecret(token);
  this.tokenHint = secretFingerprint(token);
};

/**
 * Read the refresh token back.
 *
 * Throws rather than returning null, because every caller is about to make an
 * authenticated Google call and should turn a missing token into a clear
 * "reconnect" instruction instead of a confusing provider error.
 */
googleConnectionSchema.methods.getRefreshToken = function getRefreshToken() {
  if (!this.refreshToken) {
    const err = new Error("Google is not connected for this account");
    err.status = 412;
    err.code = "GOOGLE_NOT_CONNECTED";
    throw err;
  }
  const token = decryptSecret(this.refreshToken);
  if (!token) {
    const err = new Error("The stored Google connection could not be read. Please reconnect.");
    err.status = 412;
    err.code = "GOOGLE_TOKEN_UNREADABLE";
    throw err;
  }
  return token;
};

/** Never leak credentials through an API response. */
googleConnectionSchema.set("toJSON", {
  transform(_doc, ret) {
    delete ret.refreshToken;
    return ret;
  },
});

export default mongoose.model("GoogleConnection", googleConnectionSchema);

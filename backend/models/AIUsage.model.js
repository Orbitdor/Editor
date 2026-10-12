import mongoose from "mongoose";

/**
 * Per-user AI spend tracking.
 *
 * One document per (user, period) pair. The period is an ISO-ish bucket key
 * such as `2026-09` for monthly limits or `2026-09-29` for daily ones, so quota
 * checks are a single indexed read instead of an aggregate over history.
 */
const aiUsageSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
/** Bucket key, e.g. `2026-09` or `2026-09-29`. */
    period: { type: String, required: true },
    /** Which workspace the spend is attributed to (master plan section 46). */
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    /** Document the usage belongs to, for the "usage on this doc" view. */
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    requests: { type: Number, default: 0 },
    inputChars: { type: Number, default: 0 },
    outputChars: { type: Number, default: 0 },
    ocrJobs: { type: Number, default: 0 },
    /** Dictation sessions, and the total seconds of speech they consumed. */
    voiceSessions: { type: Number, default: 0 },
    voiceSeconds: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One bucket per user per period.
aiUsageSchema.index({ user: 1, period: 1 }, { unique: true });

/** `2026-09` for a monthly bucket, `2026-09-29` for a daily one. */
export function periodKey(date = new Date(), granularity = "month") {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (granularity === "day") {
    return `${y}-${m}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return `${y}-${m}`;
}

export default mongoose.model("AIUsage", aiUsageSchema);

import mongoose from "mongoose";

/**
 * One dictation session.
 *
 * The raw transcript is kept next to the cleaned text on purpose (master plan
 * section 18): a user must always be able to compare what the engine actually
 * heard against what was inserted, otherwise an aggressive cleanup silently
 * rewrites their words.
 */
const transcriptionSchema = new mongoose.Schema(
  {
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: { type: String, default: "server" },
    /** Requested language, or "auto". */
    language: { type: String, default: "auto" },
    /** Detected language code, e.g. `ur`. */
    detectedLanguage: { type: String, default: null },
    /** Exactly what the engine returned, before any cleanup. */
    rawTranscript: { type: String, default: "" },
    /** After punctuation, paragraph and grammar cleanup. */
    processedText: { type: String, default: "" },
    /** True when the client already did the cleanup in the browser. */
    processedClientSide: { type: Boolean, default: false },
    /** Audio length in seconds, used for quota accounting. */
    durationSeconds: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
      index: true,
    },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

transcriptionSchema.index({ document: 1, createdAt: -1 });

export default mongoose.model("VoiceTranscription", transcriptionSchema);

import mongoose from "mongoose";

/**
 * One OCR run over an uploaded image.
 *
 * Jobs are persisted so a failed extraction can be inspected and retried, and so
 * the UI can poll a long-running provider instead of holding a request open.
 */
const ocrJobSchema = new mongoose.Schema(
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
    status: {
      type: String,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
      index: true,
    },
    /** "auto" lets the pipeline detect English / Urdu / Arabic / Roman Urdu. */
    language: { type: String, default: "auto" },
    /** Detected language code once the pipeline finishes. */
    detectedLanguage: { type: String, default: null },
    /** Raw provider output before cleanup. */
    rawText: { type: String, default: "" },
    /** Post-processed text that gets inserted into the document. */
    text: { type: String, default: "" },
    /** Detected block structure (headings, lists, tables, ...). */
    blocks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    /** Provider-reported confidence, 0-100. */
    confidence: { type: Number, default: null },
    /** Milliseconds spent inside the provider. */
    durationMs: { type: Number, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

ocrJobSchema.index({ document: 1, createdAt: -1 });

export default mongoose.model("OCRJob", ocrJobSchema);

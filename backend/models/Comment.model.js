import mongoose from "mongoose";

/**
 * A comment thread anchored to a piece of text in a document.
 *
 * Anchoring strategy: because the document is collaboratively edited (Yjs),
 * absolute ProseMirror positions drift as other users type. So a comment keeps
 * two things:
 *  - `anchor.from` / `anchor.to`: positions captured at creation time, used for
 *    fast highlighting when the text around them is unchanged.
 *  - `quotedText`: the exact selected text, used to re-find the range when the
 *    stored positions no longer line up.
 *
 * Replies are flat rows that point at the root comment via `parent`, which keeps
 * reads simple (one query for the whole thread) while still allowing nesting
 * depth of 1 (thread -> replies).
 */
const commentSchema = new mongoose.Schema(
  {
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    // Null for a thread root, set for replies.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    body: { type: String, required: true, maxlength: 5000 },
    quotedText: { type: String, default: "", maxlength: 2000 },
    anchor: {
      from: { type: Number, default: null },
      to: { type: Number, default: null },
    },
    // Users notified by @mentions inside `body`.
    mentions: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        email: String,
        name: String,
      },
    ],
    resolved: { type: Boolean, default: false, index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Thread roots for a document, newest first.
commentSchema.index({ document: 1, parent: 1, createdAt: -1 });

commentSchema.methods.isRoot = function () {
  return this.parent == null;
};

export default mongoose.model("Comment", commentSchema);

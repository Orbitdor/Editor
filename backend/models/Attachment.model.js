import mongoose from "mongoose";

/**
 * Attachment metadata (master plan section 27).
 *
 * The rule from section 45 is the whole reason this model is small: the bytes go
 * to object storage and MongoDB stores only what is needed to find, authorise and
 * describe them. So there is no `data` field and no binary anywhere in the
 * database.
 *
 * An attachment is always reached through its document, which means it inherits
 * the document's permission checks rather than needing its own share list.
 */
const attachmentSchema = new mongoose.Schema(
  {
    /** The document this file belongs to. Deleting the document takes it along. */
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    /**
     * Denormalised from the document so a workspace's storage total is one query,
     * and so a file cannot outlive a workspace by accident.
     */
workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    /** Who attached it. Kept for the "added by" line in the attachment list. */
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** The user's filename, sanitised. Never used as a path. */
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    mime: {
      type: String,
      required: true,
      trim: true,
    },
    /** Size on disk, used for the workspace storage quota. */
    bytes: {
      type: Number,
      required: true,
      min: 1,
    },
    /** Image, file or audio. Decides which bucket holds it and how the editor renders it. */
    kind: {
      type: String,
      enum: ["image", "file", "audio"],
      default: "file",
    },
    /**
     * The storage key: `images/<workspace>/<YYYY-MM>/<random>.<ext>`. Random, so
     * two people attaching `report.pdf` never collide and the key leaks nothing
     * about the document it belongs to.
     */
    storageKey: {
      type: String,
      required: true,
      unique: true,
    },
    /**
     * SHA-256 of the contents. Two purposes: the same file uploaded twice can be
     * recognised, and an audit can prove the bytes were not swapped after the fact.
     */
    sha256: {
      type: String,
      required: true,
    },
    /** Rendered dimensions for images, so the editor can reserve the right space. */
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  },
  { timestamps: true }
);

// The editor lists a document's attachments newest last, in one query.
attachmentSchema.index({ document: 1, createdAt: 1 });

const Attachment = mongoose.model("Attachment", attachmentSchema);
export default Attachment;
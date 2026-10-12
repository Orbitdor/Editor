import mongoose from "mongoose";

/**
 * Folders (master plan section 11, and the `folderId` in the document metadata
 * list in section 34).
 *
 * A folder always belongs to a workspace, never directly to a user. That is what
 * lets a team's folder tree travel with the team when someone moves from a
 * personal workspace into a company one, and it means the folder permission
 * check is the same membership check the documents already use.
 *
 * `parent` is optional, so the same shape covers both the flat "Work / Projects /
 * Reports" example from the plan and a genuinely nested tree.
 */
const folderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    /** The member who created it. Kept for "created by" in the UI and for audit. */
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Null means the folder sits at the top level of its workspace. */
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
      index: true,
    },
    /** Optional tint for the sidebar, as a hex string. */
    color: { type: String, default: null },
    /** Sibling ordering, so drag-and-drop can persist a position. */
    order: { type: Number, default: 0 },
    /** Soft delete, mirroring documents: trash is recoverable. */
    trashedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// The sidebar lists live folders in one ordered query; this covers it.
folderSchema.index({ workspace: 1, trashedAt: 1, order: 1 });

// A workspace cannot hold two folders with the same name at the same level.
// `null` parents are included, because Mongo treats a missing field as null in a
// unique index.
folderSchema.index(
  { workspace: 1, parent: 1, name: 1 },
  { unique: true, partialFilterExpression: { trashedAt: null } }
);

const Folder = mongoose.model("Folder", folderSchema);
export default Folder;
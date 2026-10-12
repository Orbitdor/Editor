import mongoose from "mongoose";

/**
 * Role hierarchy (highest first).
 * - owner    : full control, can share, can delete
 * - editor   : can edit content + comment
 * - commenter: can read + comment only
 * - viewer   : read only
 */
export const ROLES = ["owner", "editor", "commenter", "viewer"];

/** Roles that may be assigned to another user (owner is never shareable). */
export const ASSIGNABLE_ROLES = ["editor", "commenter", "viewer"];

const shareSchema = new mongoose.Schema(
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
    // Denormalized for display so the share list needs no extra user lookups.
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ASSIGNABLE_ROLES, default: "viewer" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// A user can only be shared a given document once (re-share updates the role).
shareSchema.index({ document: 1, user: 1 }, { unique: true });

export default mongoose.model("Share", shareSchema);

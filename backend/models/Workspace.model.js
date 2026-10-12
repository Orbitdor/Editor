import mongoose from "mongoose";

/**
 * Workspace (master plan section 36).
 *
 * Everything a person or a team owns lives inside one workspace. Every user gets
 * a personal workspace automatically; creating a team is just another workspace
 * with `isPersonal: false`.
 *
 * The plan lives here rather than on the user because it is a property of the
 * billable unit: a team on Pro should not lose its limits when one member leaves.
 */
const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** URL-safe identifier, unique across the platform. */
    slug: { type: String, required: true, lowercase: true, trim: true, index: true, unique: true },
    /** The user who created it. Also the first owner; ownership can move later. */
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** True for the single workspace every user gets for their own documents. */
    isPersonal: { type: Boolean, default: false, index: true },
    /**
     * Billing tier. `free` is the default and the only self-serve one; `pro` is
     * set by an admin or by billing, never by the user themselves.
     */
    plan: { type: String, enum: ["free", "pro"], default: "free", index: true },
    /** Set when a paid plan lapses, so limits and messaging can react. */
    planExpiresAt: { type: Date, default: null },
    /** Cached usage totals, refreshed by the workspace service rather than counted per request. */
    stats: {
      documents: { type: Number, default: 0 },
      members: { type: Number, default: 0 },
      /** Bytes of document body and attachments. */
      storageBytes: { type: Number, default: 0 },
    },
    settings: {
      /** Only owners and admins may see the audit log. */
      auditLogEnabled: { type: Boolean, default: true },
      defaultRole: { type: String, enum: ["editor", "member", "viewer"], default: "member" },
    },
    trashedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

/**
 * One personal workspace per person, enforced by the database rather than by a
 * check in the service, so two simultaneous requests cannot both create one.
 */
workspaceSchema.index(
  { owner: 1, isPersonal: 1 },
  { unique: true, partialFilterExpression: { isPersonal: true } }
);
workspaceSchema.index({ trashedAt: 1, updatedAt: -1 });

/** Response shape: never leaks the raw id fields or internal settings beyond the basics. */
workspaceSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    name: this.name,
    slug: this.slug,
    owner: String(this.owner),
    isPersonal: this.isPersonal,
    plan: this.plan,
    planExpiresAt: this.planExpiresAt,
    stats: {
      documents: this.stats?.documents || 0,
      members: this.stats?.members || 0,
      storageBytes: this.stats?.storageBytes || 0,
    },
    createdAt: this.createdAt,
  };
};

export default mongoose.models.Workspace || mongoose.model("Workspace", workspaceSchema);
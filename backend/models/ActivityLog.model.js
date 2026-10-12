import mongoose from "mongoose";

/**
 * Audit log (master plan section 49).
 *
 * One immutable row per noteworthy action inside a workspace: Ahmed updated
 * Project Proposal, 24 Sep 2026 10:32 PM.
 *
 * Append only. There is no update path and no delete path in the service, because
 * an audit trail that can be edited is not evidence of anything. Retention is a
 * deployment concern rather than something a user can switch off.
 */
export const ACTIVITY_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.plan_changed",
  "workspace.deleted",
  "member.invited",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "document.created",
  "document.updated",
  "document.trashed",
  "document.restored",
  "document.deleted",
  "document.shared",
  "share.revoked",
  "document.link.enabled",
  "document.link.revoked",
  "folder.created",
  "folder.updated",
  "folder.trashed",
  "folder.deleted",
  "document.moved",
  "document.attachment_added",
  "document.attachment_removed",
  "integration.connected",
  "integration.disconnected",
  "billing.plan_changed",
];

const activityLogSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    /** Who did it. Null for system actions such as a plan lapse. */
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    actorName: { type: String, default: null },
    action: { type: String, enum: ACTIVITY_ACTIONS, required: true, index: true },
    /** What it happened to, e.g. `{ type: "document", id: "...", name: "Proposal" }`. */
    resource: {
      type: { type: String, default: null },
      id: { type: String, default: null },
      name: { type: String, default: null },
    },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    /** Small structured detail, e.g. `{ role: "editor" }`. Never secrets. */
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The audit screen is always "newest first, optionally filtered by actor or action".
activityLogSchema.index({ workspace: 1, createdAt: -1 });

activityLogSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    action: this.action,
    actor: this.actor ? String(this.actor) : null,
    actorName: this.actorName,
    resource: this.resource,
    meta: this.meta,
    ip: this.ip,
    createdAt: this.createdAt,
  };
};

export default mongoose.models.ActivityLog || mongoose.model("ActivityLog", activityLogSchema);
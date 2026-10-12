import mongoose from "mongoose";

/**
 * Workspace membership (master plan section 36).
 *
 * One row per person per workspace. The role decides what they may do:
 *
 *   owner   - everything, including deleting the workspace and changing the plan
 *   admin   - manage members, settings and the audit log, but not delete it
 *   editor  - create and edit documents
 *   member  - read documents and comment
 *   viewer  - read only
 *
 * Ranks are declared once here and reused by the access layer, so a role means the
 * same thing everywhere.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "editor", "member", "viewer"];

/** Higher number = more power. Mirrors the document role ranking. */
export const WORKSPACE_ROLE_RANK = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

/** True when `role` meets or exceeds `minimum`. */
export function roleAtLeast(role, minimum) {
  if (!role) return false;
  return (WORKSPACE_ROLE_RANK[role] || 0) >= (WORKSPACE_ROLE_RANK[minimum] || 99);
}

const workspaceMemberSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    /**
     * Null while the invitation is still pending: the row is addressed by `email`
     * until the person signs up, at which point `claimInvitations` fills this in.
     */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    role: { type: String, enum: WORKSPACE_ROLES, default: "member" },
    /**
     * An invited person who has not accepted yet has no `user` yet, so the
     * invitation is tracked by email until they sign up.
     */
    email: { type: String, default: null, lowercase: true, trim: true, index: true },
    status: { type: String, enum: ["active", "invited"], default: "active", index: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A person appears at most once per workspace. The partial index lets several
// pending invitations share one email.
workspaceMemberSchema.index(
  { workspace: 1, user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: "objectId" } } }
);
// The same rule for pending invitations, so a double-click cannot create two rows.
workspaceMemberSchema.index(
  { workspace: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } }
);
workspaceMemberSchema.index({ workspace: 1, status: 1 });

workspaceMemberSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    workspace: String(this.workspace),
    user: this.user ? String(this.user) : null,
    email: this.email,
    name: this.user?.name || null,
    role: this.role,
    status: this.status,
    lastActiveAt: this.lastActiveAt,
    createdAt: this.createdAt,
  };
};

export default mongoose.models.WorkspaceMember || mongoose.model("WorkspaceMember", workspaceMemberSchema);
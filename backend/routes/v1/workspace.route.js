import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import {
  validateSchema,
  required,
  isString,
  isId,
  isEmail,
  isIn,
  maxLen,
} from "../../middleware/validate.middleware.js";
import {
  listMine,
  listPlans,
  create,
  getOne,
  update,
  changePlan,
  trash,
  restore,
  leave,
  listMembers,
  inviteMember,
  updateMember,
  removeMember,
  transfer,
  listActivity,
  activitySummary,
} from "../../controllers/workspace.controller.js";

/**
 * Workspace routes (master plan sections 36, 46, 49).
 *
 *   GET    /api/v1/workspaces
 *   GET    /api/v1/workspaces/plans
 *   POST   /api/v1/workspaces
 *   GET    /api/v1/workspaces/:id
 *   PATCH  /api/v1/workspaces/:id
 *   POST   /api/v1/workspaces/:id/plan
 *   DELETE /api/v1/workspaces/:id
 *   POST   /api/v1/workspaces/:id/restore
 *   POST   /api/v1/workspaces/:id/leave
 *   GET    /api/v1/workspaces/:id/members
 *   POST   /api/v1/workspaces/:id/members
 *   PATCH  /api/v1/workspaces/:id/members/:memberId
 *   DELETE /api/v1/workspaces/:id/members/:memberId
 *   POST   /api/v1/workspaces/:id/transfer
 *   GET    /api/v1/workspaces/:id/activity
 *   GET    /api/v1/workspaces/:id/activity/summary
 */
const r = Router({ mergeParams: true });
r.use(requireAuth);

/** Adding people changes who can reach a workspace, so it is metered tightly. */
const memberLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_WORKSPACE_MEMBERS) || 30,
  keyFor: (req) => `wmember:${req.user.id}`,
});

const idParam = validateSchema({ id: [required("is required"), isId()] }, "params");
const memberParam = validateSchema(
  { id: [required("is required"), isId()], memberId: [required("is required"), isId()] },
  "params"
);

r.get("/plans", listPlans);
r.get("/", listMine);
r.post(
  "/",
  memberLimit,
  validateSchema({ name: [required("is required"), isString(), maxLen(120, "too long")] }, "body"),
  create
);

r.get("/:id", idParam, getOne);
r.patch(
  "/:id",
  idParam,
  validateSchema({ name: [required("is required"), isString(), maxLen(120, "too long")] }, "body"),
  update
);
r.post(
  "/:id/plan",
  idParam,
  validateSchema({ plan: [required("is required"), isIn(["free", "pro"], "must be free or pro")] }, "body"),
  changePlan
);
r.delete("/:id", idParam, trash);
r.post("/:id/restore", idParam, restore);
r.post("/:id/leave", idParam, leave);

r.get("/:id/members", idParam, listMembers);
r.post(
  "/:id/members",
  memberLimit,
  idParam,
  validateSchema(
    {
      email: [required("is required"), isEmail("must be a valid email address")],
      role: [isIn(["admin", "editor", "member", "viewer"], "unknown role")],
    },
    "body"
  ),
  inviteMember
);
r.patch(
  "/:id/members/:memberId",
  memberLimit,
  memberParam,
  validateSchema({ role: [required("is required"), isIn(["admin", "editor", "member", "viewer"], "unknown role")] }, "body"),
  updateMember
);
r.delete("/:id/members/:memberId", memberLimit, memberParam, removeMember);
// The target member is in the body here, not the path.
r.post(
  "/:id/transfer",
  memberLimit,
  idParam,
  validateSchema({ memberId: [required("is required"), isId("invalid member id")] }, "body"),
  transfer
);

r.get("/:id/activity", idParam, listActivity);
r.get("/:id/activity/summary", idParam, activitySummary);

export default r;
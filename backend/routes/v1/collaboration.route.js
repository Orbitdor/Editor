import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import {
  validateSchema,
  required,
  isString,
  isBoolean,
  isIn,
  isId,
  maxLen,
  isIntOrNull,
} from "../../middleware/validate.middleware.js";
import {
  listComments,
  createComment,
  replyComment,
  editComment,
  resolveComment,
  deleteComment,
  getShare,
  putShare,
  removeShare,
  getAccess,
  getLinkShare,
  putLinkShare,
  deleteLinkShare,
} from "../../controllers/collaboration.controller.js";
import { ASSIGNABLE_ROLES } from "../../models/Share.model.js";
import { LINK_ROLES } from "../../services/linkshare.service.js";

const r = Router();

r.use(requireAuth);
// Collaboration writes are chatty (comments poll on every keystroke batch),
// so the ceiling is higher than for document reads.
r.use(rateLimit({ windowMs: 60_000, max: 600, keyFor: (req) => `collab:${req.user.id}` }));

/** Shared id validation for the nested comment routes. */
const idAndComment = validateSchema(
  { id: [isId()], commentId: [isId()] },
  "params"
);

// --- Comments -------------------------------------------------------------

r.get("/:id/comments", validateSchema({ id: [isId()] }, "params"), listComments);

r.post(
  "/:id/comments",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({
    body: [required("is required"), isString(), maxLen(5000, "too long")],
    quotedText: [isString(), maxLen(2000, "too long")],
    from: [isIntOrNull()],
    to: [isIntOrNull()],
  }),
  createComment
);

r.post(
  "/:id/comments/:commentId/replies",
  idAndComment,
  validateSchema({
    body: [required("is required"), isString(), maxLen(5000, "too long")],
  }),
  replyComment
);

r.patch(
  "/:id/comments/:commentId",
  idAndComment,
  validateSchema({
    body: [required("is required"), isString(), maxLen(5000, "too long")],
  }),
  editComment
);

r.post(
  "/:id/comments/:commentId/resolve",
  idAndComment,
  validateSchema({ resolved: [required("is required"), isBoolean()] }),
  resolveComment
);

r.delete("/:id/comments/:commentId", idAndComment, deleteComment);

// --- Sharing and permissions ---------------------------------------------

r.get("/:id/share", validateSchema({ id: [isId()] }, "params"), getShare);

r.put(
  "/:id/share",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({
    email: [required("is required"), isString(), maxLen(200, "too long")],
    role: [isIn(ASSIGNABLE_ROLES, `must be one of ${ASSIGNABLE_ROLES.join("|")}`)],
  }),
  putShare
);

r.delete(
  "/:id/share/:userId",
  validateSchema({ id: [isId()], userId: [isId()] }, "params"),
  removeShare
);

r.get("/:id/access", validateSchema({ id: [isId()] }, "params"), getAccess);

// "Anyone with the link". Owner-only, like the rest of the sharing controls, and
// deliberately separate from the per-person share list above.
r.get("/:id/link", validateSchema({ id: [isId()] }, "params"), getLinkShare);

r.put(
  "/:id/link",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({
    role: [isIn(LINK_ROLES, `must be one of ${LINK_ROLES.join("|")}`)],
    expiresInDays: [isIntOrNull()],
    enabled: [isBoolean()],
  }),
  putLinkShare
);

r.delete("/:id/link", validateSchema({ id: [isId()] }, "params"), deleteLinkShare);

export default r;

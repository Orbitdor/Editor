import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, isString, maxLen } from "../../middleware/validate.middleware.js";
import {
  listNotifications,
  markNotificationsRead,
  searchUsers,
} from "../../controllers/collaboration.controller.js";

const r = Router();

r.use(requireAuth);
r.use(rateLimit({ windowMs: 60_000, max: 300, keyFor: (req) => `notif:${req.user.id}` }));

// GET /api/v1/notifications
r.get(
  "/",
  validateSchema({ limit: [isString(), maxLen(10, "too long")] }, "query"),
  listNotifications
);

// POST /api/v1/notifications/read  body: { ids?: string[] } (omit ids = all)
r.post("/read", markNotificationsRead);

// GET /api/v1/notifications/mention-search?q=ali
// Powers the @mention autocomplete popup inside the editor.
r.get(
  "/mention-search",
  validateSchema(
    { q: [isString(), maxLen(64, "too long")], limit: [isString(), maxLen(4, "too long")] },
    "query"
  ),
  searchUsers
);

export default r;

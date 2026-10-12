import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, isString, maxLen } from "../../middleware/validate.middleware.js";
import { listSharedWithMe } from "../../controllers/collaboration.controller.js";

const r = Router();

r.use(requireAuth);
r.use(rateLimit({ windowMs: 60_000, max: 300, keyFor: (req) => `shared:${req.user.id}` }));

// GET /api/v1/shared  -> documents other people shared with me
r.get(
  "/",
  validateSchema(
    { q: [isString(), maxLen(100, "too long")] },
    "query"
  ),
  async (req, res) => {
    res.json(await listSharedWithMe(req.user.id));
  }
);

export default r;

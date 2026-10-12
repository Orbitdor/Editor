import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, isId, isIn, maxLen } from "../../middleware/validate.middleware.js";
import { getStatus, getUsage, runAction, ask } from "../../controllers/ai.controller.js";
import { AI_ACTIONS, SUPPORTED_LANGUAGES, AI_TONES } from "../../config/ai.js";

/**
 * Document-scoped AI routes, mounted at /api/v1/documents/:id/ai, so paths in
 * this file are relative to that mount point:
 *   POST /api/v1/documents/:id/ai/action
 *   POST /api/v1/documents/:id/ai/ask
 */
const r = Router({ mergeParams: true });

r.use(requireAuth);

// AI calls cost money, so they get a much tighter rate limit than document reads.
const aiLimit = rateLimit({ windowMs: 60_000, max: 30, keyFor: (req) => `ai:${req.user.id}` });

const idOnly = validateSchema({ id: [isId()] }, "params");

const actionValidator = validateSchema(
  {
    action: [required("is required"), isIn(AI_ACTIONS, `must be one of ${AI_ACTIONS.join("|")}`)],
    text: [isString(), maxLen(20000, "too long")],
    selection: [isString(), maxLen(20000, "too long")],
    tone: [isIn(AI_TONES, `must be one of ${AI_TONES.join("|")}`)],
    language: [isIn(SUPPORTED_LANGUAGES, `must be one of ${SUPPORTED_LANGUAGES.join("|")}`)],
  },
  "body"
);

r.post("/action", aiLimit, idOnly, actionValidator, runAction);

r.post(
  "/ask",
  aiLimit,
  idOnly,
  validateSchema(
    {
      question: [required("is required"), isString(), maxLen(2000, "too long")],
      language: [isIn(SUPPORTED_LANGUAGES, `must be one of ${SUPPORTED_LANGUAGES.join("|")}`)],
    },
    "body"
  ),
  ask
);

export default r;

/**
 * Global AI routes, mounted at /api/v1/ai:
 *   GET /api/v1/ai/status   provider capability
 *   GET /api/v1/ai/usage    quota snapshot for the signed-in user
 */
export const globalAiRouter = Router();
globalAiRouter.use(requireAuth);
globalAiRouter.get("/status", getStatus);
globalAiRouter.get("/usage", getUsage);

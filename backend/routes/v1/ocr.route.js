import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, isId, isIn, maxLen } from "../../middleware/validate.middleware.js";
import { runOcr, listJobs, getJob } from "../../controllers/ai.controller.js";
import { SUPPORTED_LANGUAGES } from "../../config/ai.js";

/**
 * OCR routes, mounted under /api/v1/documents so an extraction is always
 * scoped to one document:
 *   POST /api/v1/documents/:id/ocr
 *   GET  /api/v1/documents/:id/ocr
 *   GET  /api/v1/documents/:id/ocr/:jobId
 */
const r = Router();

r.use(requireAuth);

// OCR is the most expensive operation (an image upload to a vision model).
const ocrLimit = rateLimit({ windowMs: 60_000, max: 10, keyFor: (req) => `ocr:${req.user.id}` });

const idOnly = validateSchema({ id: [isId()] }, "params");

/**
 * Images arrive as base64 inside the JSON body, so the shared 5mb express limit
 * applies first. The validator cap is a second, explicit ceiling.
 */
const imageValidator = validateSchema(
  {
    image: [required("is required"), isString(), maxLen(8 * 1024 * 1024, "too large")],
    language: [isIn(SUPPORTED_LANGUAGES, `must be one of ${SUPPORTED_LANGUAGES.join("|")}`)],
    // `google` opts this one request into the caller's own Cloud Vision
    // connection; omitting it keeps the server default.
    provider: [isIn(["openai", "google"], "must be openai or google")],
  },
  "body"
);

r.post("/:id/ocr", ocrLimit, idOnly, imageValidator, runOcr);
r.get("/:id/ocr", idOnly, listJobs);
r.get("/:id/ocr/:jobId", validateSchema({ id: [isId()], jobId: [isId()] }, "params"), getJob);

export default r;

import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, isId, isIn, maxLen } from "../../middleware/validate.middleware.js";
import { runOcr, listJobs, getJob, getOcrProgress } from "../../controllers/ai.controller.js";
import { SUPPORTED_LANGUAGES } from "../../config/ai.js";

/**
 * OCR routes, mounted under /api/v1/documents so an extraction is always
 * scoped to one document:
 *   POST /api/v1/documents/:id/ocr
 *   GET  /api/v1/documents/:id/ocr
 *   GET  /api/v1/documents/:id/ocr/progress/:progressId
 *   GET  /api/v1/documents/:id/ocr/:jobId
 */
const r = Router();

r.use(requireAuth);

// OCR is the most expensive operation (image decoding plus recognition, or an
// upload to a vision model).
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
    // connection, `openai` into the vision model; omitting it uses the server
    // default (the bundled local engine).
    provider: [isIn(["local", "tesseract", "openai", "google"], "must be local, openai or google")],
    // Optional client-generated id; when present the client can poll
    // .../ocr/progress/:progressId while the POST is still running.
    progressId: [isString(), maxLen(64, "too long")],
  },
  "body"
);

r.post("/:id/ocr", ocrLimit, idOnly, imageValidator, runOcr);
r.get("/:id/ocr", idOnly, listJobs);
// Declared before the jobId route so "progress" is never mistaken for a job id.
// Deliberately not under ocrLimit: polling must not consume the extraction budget.
r.get(
  "/:id/ocr/progress/:progressId",
  validateSchema({ id: [isId()], progressId: [isString(), maxLen(64)] }, "params"),
  getOcrProgress
);
r.get("/:id/ocr/:jobId", validateSchema({ id: [isId()], jobId: [isId()] }, "params"), getJob);

export default r;

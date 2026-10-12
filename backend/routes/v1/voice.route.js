import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, isId, isIn, isNonNegativeNumber, maxLen } from "../../middleware/validate.middleware.js";
import { getStatus, transcribe, finish, listSessions, getSession } from "../../controllers/voice.controller.js";
import { SUPPORTED_SPEECH_LANGUAGES } from "../../config/voice.js";

/**
 * Voice routes.
 *
 * A document-scoped router for dictation, plus a global one for the capability
 * probe the microphone button calls on mount:
 *
 *   POST /api/v1/documents/:id/voice/transcribe
 *   POST /api/v1/documents/:id/voice/finish
 *   GET  /api/v1/documents/:id/voice
 *   GET  /api/v1/documents/:id/voice/:transcriptionId
 *   GET  /api/v1/voice/status
 */
const docVoiceRouter = Router({ mergeParams: true });
docVoiceRouter.use(requireAuth);

const globalVoiceRouter = Router({ mergeParams: true });
globalVoiceRouter.use(requireAuth);

/**
 * Dictation is priced per minute, so the per-user limiter is tighter than the
 * generic AI one. The daily ceiling in `usage.service.js` is the real guard; this
 * only smooths bursts from a single client.
 */
const voiceLimit = rateLimit({ windowMs: 60_000, max: 20, keyFor: (req) => `voice:${req.user.id}` });

const idOnly = validateSchema({ id: [isId()] }, "params");

const languageValidator = {
  language: [
    isIn(
      SUPPORTED_SPEECH_LANGUAGES,
      `must be one of ${SUPPORTED_SPEECH_LANGUAGES.join("|")}`
    ),
  ],
};

/**
 * Audio arrives as base64 inside the JSON body. `config/voice.js` holds the real
 * ceiling; this cap exists so an oversized body is rejected by validation with a
 * clear message rather than by the express parser.
 */
const audioValidator = validateSchema(
  {
    audio: [required("is required"), isString(), maxLen(20 * 1024 * 1024, "too large")],
    durationSeconds: [isNonNegativeNumber()],
    // `google` opts this one request into the caller's own Cloud Speech
    // connection; omitting it keeps the server default.
    provider: [isIn(["openai", "google"], "must be openai or google")],
    ...languageValidator,
  },
  "body"
);

const finishValidator = validateSchema(
  {
    transcript: [required("is required"), isString(), maxLen(20_000, "too long")],
    durationSeconds: [isNonNegativeNumber()],
    provider: [isIn(["browser"], "must be browser")],
    ...languageValidator,
  },
  "body"
);

docVoiceRouter.post("/transcribe", voiceLimit, idOnly, audioValidator, transcribe);
docVoiceRouter.post("/finish", voiceLimit, idOnly, finishValidator, finish);
docVoiceRouter.get("/", idOnly, listSessions);
docVoiceRouter.get(
  "/:transcriptionId",
  validateSchema({ id: [isId()], transcriptionId: [isId()] }, "params"),
  getSession
);

globalVoiceRouter.get("/status", getStatus);

export default docVoiceRouter;
export { globalVoiceRouter };

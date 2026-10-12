import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, maxLen } from "../../middleware/validate.middleware.js";
import {
  getStatus,
  startConnect,
  connectCallback,
  disconnect,
  listFiles,
  importFile,
  exportDoc,
} from "../../controllers/google.controller.js";

/**
 * Google integration routes (master plan sections 29-31).
 *
 *   GET    /api/v1/integrations/google/status
 *   GET    /api/v1/integrations/google/start?groups=drive,docs
 *   GET    /api/v1/integrations/google/callback
 *   DELETE /api/v1/integrations/google
 *   GET    /api/v1/integrations/google/files?q=
 *   GET    /api/v1/integrations/google/files/:fileId
 *   POST   /api/v1/integrations/google/export
 *
 * The callback is behind `requireAuth` on purpose: a sign-in-free attacker who
 * knew a state value still could not attach a Drive grant to somebody else's
 * account, because the session is what identifies whose connection is written.
 * Google redirects back with the session cookie intact, since the callback is a
 * same-origin GET.
 */
const r = Router({ mergeParams: true });
r.use(requireAuth);

/**
 * Drive calls consume the user's own Google quota, so they are metered more
 * tightly than ordinary reads. The connect flow itself is even tighter, because
 * a loop of connects is a way to try to farm consent.
 *
 * These ceilings are generous for a real user, who spends one request per
 * connect and a handful per import, but configurable because the automated suite
 * drives the whole flow from a single IP and would otherwise trip its own guard.
 */
const driveLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_GOOGLE_DRIVE) || 30,
  keyFor: (req) => `gdrive:${req.user.id}`,
});
const connectLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_GOOGLE_CONNECT) || 10,
  keyFor: (req) => `gconnect:${req.user.id}`,
});

r.get("/status", getStatus);
r.get("/start", connectLimit, startConnect);
r.get("/callback", connectCallback);
r.delete("/", disconnect);
r.get("/files", driveLimit, listFiles);
r.get("/files/:fileId", driveLimit, validateSchema({ fileId: [required("is required"), isString(), maxLen(200, "too long")] }, "params"), importFile);
r.post(
  "/export",
  driveLimit,
  validateSchema(
    {
      title: [required("is required"), isString(), maxLen(200, "too long")],
      html: [required("is required"), isString(), maxLen(2_000_000, "too large")],
    },
    "body"
  ),
  exportDoc
);

export default r;

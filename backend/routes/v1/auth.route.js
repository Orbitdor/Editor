import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { validateSchema, required, isString, isId, maxLen } from "../../middleware/validate.middleware.js";
import { rateLimit, securityHeaders } from "../../middleware/error.middleware.js";
import { Login } from "../../controllers/auth/login.controller.js";
import { Register } from "../../controllers/auth/register.controller.js";
import { Logout, LogoutAll, Refresh, RevokeSession, Sessions } from "../../controllers/auth/session.controller.js";
import { startSignIn, signInCallback, exchangeTicket } from "../../controllers/google.controller.js";

const r = Router();

r.use(securityHeaders);

// Registration is strictly limited in production, but the automated test suite
// creates a dozen throwaway accounts in a single run from one IP, so the ceiling
// is configurable to keep the tests from tripping their own guard.
const REGISTER_MAX = Number(process.env.RATE_LIMIT_REGISTER) || 10;
const LOGIN_MAX = Number(process.env.RATE_LIMIT_LOGIN) || 20;

// One sign-in is one start plus one callback, so this ceiling is well clear of
// real use. It is configurable for the same reason as the register and login
// limits above: the suite drives several complete flows from one address.
const signInLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_GOOGLE_SIGNIN) || 15,
  keyFor: (req) => `gsignin:${req.ip}`,
});

r.post(
  "/register",
  rateLimit({ windowMs: 60_000, max: REGISTER_MAX, keyFor: (req) => `reg:${req.ip}` }),
  validateSchema({
    name: [required("is required"), isString(), maxLen(100, "too long")],
    email: [required("is required"), isString(), maxLen(200, "too long")],
    password: [required("is required"), isString(), maxLen(200, "too long")],
  }),
  Register
);

r.post(
  "/login",
  rateLimit({ windowMs: 60_000, max: LOGIN_MAX, keyFor: (req) => `login:${req.ip}` }),
  validateSchema({
    email: [required("is required"), isString(), maxLen(200, "too long")],
    password: [required("is required"), isString(), maxLen(200, "too long")],
  }),
  Login
);

// Session lifecycle (master plan section 8: rotating refresh tokens, secure
// HttpOnly cookies, session management, logout all devices).
//
// These are the only endpoints that authenticate by cookie rather than by
// requireAuth, because refreshing is exactly the moment there is no valid access
// token left. SameSite=Strict on the cookie is what stops another site from
// calling them.
r.post("/refresh", signInLimit, Refresh);
r.post("/logout", signInLimit, Logout);
r.get("/sessions", requireAuth, Sessions);
r.delete("/sessions/:sessionId", requireAuth, validateSchema({ sessionId: [isId()] }, "params"), RevokeSession);
r.post("/logout-all", requireAuth, signInLimit, LogoutAll);

export default r;

/**
 * Google sign-in (master plan section 9).
 *
 * Exported separately so it can be mounted by `index.js`, and deliberately kept
 * out of the router above: sign-in is the one flow where the caller has no
 * session yet, so it must not sit behind `requireAuth`. It also asks for the
 * `email profile` scopes only, never the Drive scopes, so signing in cannot
 * silently grant file access.
 */
export const googleAuthRouter = Router();
googleAuthRouter.use(securityHeaders);

googleAuthRouter.get("/start", signInLimit, startSignIn);
googleAuthRouter.get("/callback", signInLimit, signInCallback);
// The browser lands here with a single-use ticket rather than a token in the URL.
googleAuthRouter.post(
  "/session",
  signInLimit,
  validateSchema({ ticket: [required("is required"), isString(), maxLen(200, "too long")] }, "body"),
  exchangeTicket
);
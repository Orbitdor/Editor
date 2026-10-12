import * as oauth from "../services/google.oauth.js";
import * as drive from "../services/google.drive.js";
import User from "../models/User.model.js";
import { ApiError } from "../utils/ApiError.js";
import { googleConfig, googleStatus } from "../config/google.js";
import { isEncryptionConfigured } from "../services/tokenVault.js";
import { attachCookies, startSession } from "../services/token.service.js";

/**
 * Google integration HTTP layer (master plan sections 29-31).
 *
 * Two separate surfaces, deliberately not merged:
 *   - `/integrations/google/*` manages the Drive/Docs connection. Requires auth.
 *   - `/auth/google/*` is sign-in, and is public by necessity since the user has
 *     no session yet when they arrive.
 *
 * Controllers stay thin; the OAuth flow's state handling lives in the service.
 */

// GET /api/v1/integrations/google/status -> capability + current connection
export const getStatus = async (req, res) => {
  const connection = await oauth.getConnection(req.user.id);
  res.json({
    ...googleStatus(),
    encryptionConfigured: isEncryptionConfigured(),
    connection: oauth.describeConnection(connection),
  });
};

/** GET /api/v1/integrations/google/start?groups=drive,docs -> consent URL */
export const startConnect = (req, res) => {
  const groups = String(req.query.groups || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  res.json(oauth.startConnect(req.user.id, groups));
};

/** GET /api/v1/integrations/google/callback -> the OAuth redirect target */
export const connectCallback = async (req, res) => {
  const { code, state, error } = req.query;

  if (error) throw new ApiError(400, `Google returned an error: ${error}`);

  const connection = await oauth.completeConnect({ code, state });
  res.json(connection);
};

/** DELETE /api/v1/integrations/google -> revoke and forget the connection */
export const disconnect = async (req, res) => {
  res.json(await oauth.disconnect(req.user.id));
};

/** GET /api/v1/integrations/google/files?q= -> Drive files for the picker */
export const listFiles = async (req, res) => {
  const connection = await oauth.getConnection(req.user.id);
  const accessToken = await oauth.withAccessToken(connection);
  res.json(
    await drive.listFiles(accessToken, {
      q: req.query.q,
      limit: req.query.limit,
      cursor: req.query.cursor,
    })
  );
};

/**
 * GET /api/v1/integrations/google/files/:fileId -> the file, converted to Tiptap.
 *
 * The import preview is read-only: the client shows the converted document and
 * its limitation list, then creates its own document. Nothing is written to the
 * user's library until they confirm.
 */
export const importFile = async (req, res) => {
  const connection = await oauth.getConnection(req.user.id);
  const accessToken = await oauth.withAccessToken(connection);
  res.json(await drive.importDoc(accessToken, req.params.fileId));
};

/** POST /api/v1/integrations/google/export -> upload a document to Drive */
export const exportDoc = async (req, res) => {
  const { title, html } = req.body || {};
  const connection = await oauth.getConnection(req.user.id);
  const accessToken = await oauth.withAccessToken(connection);
  res.json(await drive.exportDoc(accessToken, { title, html }));
};

/**
 * Google sign-in
 */

/** GET /api/v1/auth/google/start -> consent URL for authentication */
export const startSignIn = (req, res) => {
  res.json(oauth.startSignIn({ returnTo: req.query.returnTo }));
};

/** GET /api/v1/auth/google/callback -> the app's own JWT, plus the user */
export const signInCallback = async (req, res) => {
  const { code, state, error } = req.query;
  if (error) throw new ApiError(400, `Google sign-in failed: ${error}`);

  const result = await oauth.completeSignIn({ code, state });

  // A browser arriving here is mid-redirect, so it gets sent onward to the app
  // with a single-use ticket rather than a page of JSON. An API client asking for
  // JSON gets the session directly.
  if (wantsJson(req)) {
    // An API client gets the session and the cookies in one response; there is
    // no redirect hop for it to worry about.
    const user = await User.findById(result.userId);
    if (user) {
      const opened = await startSession(user, req);
      attachCookies(res, { accessToken: opened.accessToken, refreshToken: opened.refreshToken });
      return res.json({ message: "Signed in with Google", ...result, token: opened.accessToken });
    }
    return res.json({
      message: "Signed in with Google",
      ...result,
    });
  }

  const ticket = oauth.issueTicket(result);
  const target = new URL("/auth/google/callback", googleConfig().frontendUrl);
  target.searchParams.set("ticket", ticket);
  return res.redirect(302, target.toString());
};

/**
 * POST /api/v1/auth/google/session -> trade a callback ticket for the JWT.
 *
 * Separate from the callback so the token never travels in a URL.
 */
export const exchangeTicket = async (req, res) => {
  const { ticket } = req.body || {};
  if (!ticket) throw new ApiError(400, "Missing ticket");

  const session = oauth.consumeTicket(ticket);

  // The cookie is set here rather than on the OAuth redirect, because a browser
  // is not guaranteed to keep a SameSite=Strict cookie handed to it by a
  // cross-site redirect. This call is same-site, so the cookie sticks.
  const user = await User.findById(session.userId);
  if (!user) throw new ApiError(401, "Account no longer exists");
  const opened = await startSession(user, req);
  attachCookies(res, { accessToken: opened.accessToken, refreshToken: opened.refreshToken });

  res.json({
    message: "Signed in with Google",
    token: opened.accessToken,
    isNewUser: session.isNewUser,
    emailVerified: session.emailVerified,
    returnTo: session.returnTo,
    user: session.user,
  });
};

/** True unless the caller is a browser following the OAuth redirect. */
function wantsJson(req) {
  return !String(req.get("accept") || "").includes("text/html");
}

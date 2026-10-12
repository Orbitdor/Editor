import { ApiError } from "../../utils/ApiError.js";
import { hashToken } from "../../models/Session.model.js";
import {
  REFRESH_COOKIE,
  SOCKET_TTL_SECONDS,
  attachCookies,
  clearAuthCookies,
  listSessions,
  readCookie,
  revokeAllSessions,
  revokeSession,
  revokeSessionById,
  rotateSession,
  signSocketToken,
} from "../../services/token.service.js";

/**
 * Rotate the refresh cookie and mint a fresh access token.
 *
 * The frontend calls this on a 401 and retries the original request, so the user
 * never sees a session expire mid-edit.
 */
export const Refresh = async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) throw new ApiError(401, "No session");

  const { accessToken, refreshToken, user } = await rotateSession(raw, req);
  attachCookies(res, { accessToken, refreshToken });

  res.json({
    message: "Session refreshed",
    // The access token is echoed for non-browser clients; the browser reads it
    // from the HttpOnly cookie and ignores this field.
    token: accessToken,
    user: { id: user._id, name: user.name, email: user.email },
  });
};

/** Sign out this device only. */
export const Logout = async (req, res) => {
  await revokeSession(readCookie(req, REFRESH_COOKIE));
  clearAuthCookies(res);
  res.json({ message: "Signed out" });
};

/** Sign out everywhere. Requires a live access token, so it cannot be triggered
 *  by a stray request on a logged-out browser. */
export const LogoutAll = async (req, res) => {
  const count = await revokeAllSessions(req.user.id);
  clearAuthCookies(res);
  res.json({ message: "Signed out of all devices", revoked: count });
};

/** The "your devices" screen: every live session for this account. */
export const Sessions = async (req, res) => {
  const rows = await listSessions(req.user.id);
  // Only the digest is stored, so the caller's raw cookie has to be hashed
  // before it can be matched against a row.
  const currentHash = hashToken(readCookie(req, REFRESH_COOKIE));
  res.json({
    sessions: rows.map((s) => ({
      id: s._id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      isCurrent: !!currentHash && s.tokenHash === currentHash,
    })),
  });
};

/** Revoke one session by id (used by "sign out this device"). */
export const RevokeSession = async (req, res) => {
  const revoked = await revokeSessionById(req.user.id, req.params.sessionId);
  res.json({ revoked });
};

/**
 * Mint a short-lived token for the notification WebSocket.
 *
 * The socket may be hosted on a different origin than the cookie that proves the
 * session, so it cannot authenticate by cookie. The browser calls this over the
 * same-origin API (cookie included) and passes the token in the socket URL.
 */
export const SocketToken = async (req, res) => {
  res.json({ token: signSocketToken(req.user), expiresIn: SOCKET_TTL_SECONDS });
};
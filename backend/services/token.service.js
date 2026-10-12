import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import Session, { hashToken } from "../models/Session.model.js";
import { ApiError } from "../utils/ApiError.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

/**
 * Access tokens are deliberately short. A stolen one is then worth minutes, not
 * weeks, and the browser recovers silently through the refresh cookie.
 */
export const ACCESS_TTL = process.env.JWT_ACCESS_TTL || "15m";
export const REFRESH_DAYS = Number(process.env.JWT_REFRESH_DAYS) || 30;

export const ACCESS_COOKIE = "ae_at";
export const REFRESH_COOKIE = "ae_rt";

const REFRESH_MS = REFRESH_DAYS * 24 * 60 * 60 * 1000;

/**
 * `SameSite=Strict` is the CSRF defence for the refresh cookie: a cross-site
 * form post or fetch never carries it, so an attacker's page cannot trigger a
 * rotation. `secure` is enabled whenever the app is not in development, since
 * an HttpOnly cookie over plain HTTP is readable by anything on the path.
 */
function cookieOptions(maxAgeMs, httpOnly = true) {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function clearAuthCookies(res) {
  // clearCookie only needs to match the original attributes; a maxAge would
  // fight the expiry date it sets.
  const { maxAge, ...attrs } = cookieOptions(0);
  res.clearCookie(ACCESS_COOKIE, attrs);
  res.clearCookie(REFRESH_COOKIE, attrs);
}

/** Minimal cookie-header parser; avoids adding a dependency for four lines. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function signAccessToken(user) {
  return jwt.sign({ id: user._id, email: user.email }, SECRET, {
    expiresIn: ACCESS_TTL,
  });
}

/**
 * Create a device session and return `{ accessToken, refreshToken, session }`.
 * The refresh token is returned exactly once: only its digest is persisted.
 */
export async function startSession(user, req) {
  const raw = crypto.randomBytes(48).toString("hex");
  const session = await Session.create({
    user: user._id,
    tokenHash: hashToken(raw),
    userAgent: (req?.headers?.["user-agent"] || "").slice(0, 300),
    ip: (req?.ip || "").slice(0, 100),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_MS),
  });
  return { accessToken: signAccessToken(user), refreshToken: raw, session };
}

/** Attach both cookies to a response. */
export function attachCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_MS));
}

/**
 * Exchange a refresh token for a new pair, rotating the old one away.
 *
 * A token that is already revoked but whose digest is still on file means it was
 * replayed. That is the one case where we cannot tell a stolen token from a
 * genuine double-submit, so the safe answer is to cut the entire chain: every
 * session descended from the replayed one dies with it.
 */
export async function rotateSession(raw, req) {
  const session = await Session.findOne({ tokenHash: hashToken(raw) });
  if (!session) throw new ApiError(401, "Invalid or expired session");

  if (session.revokedAt) {
    await Session.updateMany(
      { user: session.user, rotatedFrom: session.tokenHash },
      { $set: { revokedAt: new Date() } }
    );
    throw new ApiError(401, "Session reuse detected. Please sign in again.");
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  const fresh = crypto.randomBytes(48).toString("hex");
  const next = await Session.create({
    user: session.user,
    tokenHash: hashToken(fresh),
    rotatedFrom: session.tokenHash,
    userAgent: (req?.headers?.["user-agent"] || "").slice(0, 300),
    ip: (req?.ip || "").slice(0, 100),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_MS),
  });

  session.revokedAt = new Date();
  await session.save();

  const user = await session.populate("user");
  return {
    accessToken: signAccessToken(user),
    refreshToken: fresh,
    session: next,
    user,
  };
}

/** Revoke just this device. */
export async function revokeSession(raw) {
  if (!raw) return false;
  const result = await Session.updateOne(
    { tokenHash: hashToken(raw), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/** Revoke every live session for a user ("log out all devices"). */
export async function revokeAllSessions(userId) {
  const result = await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount;
}

/** Revoke one device by its id, scoped to the owner so ids cannot be guessed. */
export async function revokeSessionById(userId, sessionId) {
  const result = await Session.updateOne(
    { _id: sessionId, user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/** Live sessions, newest first, for the "your devices" screen. */
export async function listSessions(userId) {
  return Session.find({ user: userId, revokedAt: null })
    .sort({ lastUsedAt: -1 })
    .lean();
}
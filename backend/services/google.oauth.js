import crypto from "node:crypto";
import GoogleConnection from "../models/GoogleConnection.model.js";
import User from "../models/User.model.js";
import { ApiError } from "../utils/ApiError.js";
import { signAccessToken } from "./token.service.js";
import {
  googleConfig,
  isGoogleConfigured,
  promptForAccessType,
  resolveScopes,
} from "../config/google.js";

/**
 * Google OAuth 2.0 authorisation-code flow with offline access (master plan
 * section 29).
 *
 * Two distinct flows share this module, deliberately kept apart:
 *
 *   - Sign-in (`startSignIn` / `completeSignIn`) asks only for `openid email
 *     profile`. It never touches a file and never stores a refresh token.
 *   - Connect (`startConnect` / `completeConnect`) asks for the Drive/Docs scopes
 *     and stores an encrypted refresh token on a `GoogleConnection`.
 *
 * Mixing them would either demand file access just to log someone in, or leave a
 * Drive grant unused at sign-in time. A single-use, signed `state` parameter
 * carries the flow and its return URL between the redirect and the callback.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

/** Per-process map of issued state values, so a callback can be validated. */
const pendingStates = new Map();

/**
 * Issue a single-use state value that remembers where to return after consent.
 *
 * @param {{flow: "auth"|"connect", returnTo: string, groups?: string[], userId?: string}} data
 * @returns {string}
 */
function issueState(data) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  pendingStates.set(nonce, { ...data, expiresAt: Date.now() + STATE_TTL_MS });
  pruneStates();
  return nonce;
}

/** Drop expired and excess state values so the map cannot grow unbounded. */
function pruneStates() {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (value.expiresAt < now) pendingStates.delete(key);
  }
  // A burst of connects should not keep every entry alive for the full TTL.
  while (pendingStates.size > 500) {
    pendingStates.delete(pendingStates.keys().next().value);
  }
}

/** Consume a state value, throwing if it is unknown, reused or expired. */
function consumeState(state) {
  if (!state) throw new ApiError(400, "Missing state parameter");
  const entry = pendingStates.get(state);
  // Deleted either way: a state value is single-use, which is what stops a
  // replayed callback from exchanging a code a second time.
  pendingStates.delete(state);
  if (!entry) throw new ApiError(400, "This sign-in link has expired. Please try again.");
  if (entry.expiresAt < Date.now()) throw new ApiError(400, "This sign-in link has expired.");
  return entry;
}

/** Only allow redirects back to our own frontend. */
function safeReturnTo(value) {
  const fallback = "/";
  if (!value || typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

/**
 * Hand the finished session to the browser without putting it in the URL.
 *
 * The callback cannot simply redirect with the JWT in the query string: URLs end
 * up in history, proxy logs and `Referer` headers. Instead the callback mints a
 * single-use ticket that the frontend redeems over POST for the token.
 *
 * Like the state map this is per-process, which is fine for a single instance
 * and behind one load balancer; a multi-instance deployment would move it to
 * Redis or a signed short-lived token.
 */
const TICKET_TTL_MS = 60 * 1000;
const pendingTickets = new Map();

export function issueTicket(session) {
  const ticket = crypto.randomBytes(24).toString("base64url");
  pendingTickets.set(ticket, { session, expiresAt: Date.now() + TICKET_TTL_MS });
  while (pendingTickets.size > 500) {
    pendingTickets.delete(pendingTickets.keys().next().value);
  }
  return ticket;
}

/** Redeem a ticket exactly once, or throw. */
export function consumeTicket(ticket) {
  const entry = pendingTickets.get(ticket);
  pendingTickets.delete(ticket);
  if (!entry) throw new ApiError(400, "This sign-in link has expired. Please try again.");
  if (entry.expiresAt < Date.now()) throw new ApiError(400, "This sign-in link has expired.");
  return entry.session;
}

/** Build the consent-screen URL. */
function authorizeUrl({ state, groups, prompt, redirectUri }) {
  const cfg = googleConfig();
  const { scopes } = resolveScopes(groups);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    // Falls back to the connect URI, which is correct for the connect flow.
    redirect_uri: redirectUri || cfg.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    // `access_type=offline` is what makes Google issue a refresh token at all.
    access_type: "offline",
    include_granted_scopes: "true",
    prompt,
  });
  return `${cfg.authUrl}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(code) {
  const cfg = googleConfig();
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, `Google rejected the authorization code (${res.status})`, text.slice(0, 500));
  }
  return res.json();
}

/** Ask Google who the token belongs to. */
async function fetchIdentity(accessToken) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, `Could not read the Google profile (${res.status})`, text.slice(0, 500));
  }
  return res.json();
}

/** Turn an expired-or-absent access token into a fresh one. */
async function refreshAccessToken(refreshToken) {
  const cfg = googleConfig();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(401, "The Google connection is no longer valid. Please reconnect.", text.slice(0, 300));
  }
  return res.json();
}

/**
 * Offline stand-ins, so the flow is testable with no credentials.
 *
 * The identity is derived from the authorization code rather than randomised,
 * which is what makes the mock behave like Google: the same code maps to the
 * same Google account, so signing in twice returns the same app user, while a
 * different code is a different person.
 */
function mockSeed(code) {
  return crypto.createHash("sha256").update(`mock-google:${code}`).digest("hex").slice(0, 10);
}

function mockExchange(code) {
  const seed = mockSeed(code);
  return {
    access_token: `mock-access-${seed}`,
    refresh_token: `mock-refresh-${seed}`,
    expires_in: 3600,
    token_type: "Bearer",
    scope: "",
  };
}

function mockIdentity(code) {
  const seed = mockSeed(code);
  return {
    sub: `mock-google-user-${seed}`,
    email: `google.user.${seed}@example.com`,
    email_verified: true,
    name: `Google User ${seed}`,
    picture: null,
  };
}

/**
 * Begin "Sign in with Google".
 *
 * @param {{returnTo?: string}} [params]
 * @returns {{url: string, mock: boolean}}
 */
export function startSignIn({ returnTo } = {}) {
  const cfg = googleConfig();
  if (!isGoogleConfigured(cfg) && !cfg.allowMock) {
    throw new ApiError(503, "Google sign-in is not configured on this server.");
  }

  const state = issueState({ flow: "auth", returnTo: safeReturnTo(returnTo) });
  return {
    url: authorizeUrl({
      state,
      groups: ["auth"],
      prompt: "select_account",
      redirectUri: cfg.signInRedirectUri,
    }),
    mock: !isGoogleConfigured(cfg),
  };
}

/**
 * Finish "Sign in with Google" and return the app's own JWT.
 *
 * Account linking follows one rule: Google is trusted for the email, so if an
 * account already exists with that address it is linked rather than duplicated.
 * The password is never touched, so an existing password login keeps working.
 * A lookup by Google's own user id runs first, so an account still matches after
 * its Google email changes, and linking to an existing account additionally
 * requires Google to vouch for the address: an unverified Google email must not
 * be able to claim an account it does not own.
 *
 * @param {{code: string, state: string}} params
 * @returns {Promise<{token: string, user: object, isNewUser: boolean, emailVerified: boolean, returnTo: string}>}
 */
export async function completeSignIn({ code, state }) {
  if (!code) throw new ApiError(400, "Missing authorization code");
  const entry = consumeState(state);
  if (entry.flow !== "auth") throw new ApiError(400, "This callback does not match the sign-in flow");

  const cfg = googleConfig();
  const tokens = isGoogleConfigured(cfg) ? await exchangeCode(code) : mockExchange(code);
  const identity = isGoogleConfigured(cfg)
    ? await fetchIdentity(tokens.access_token)
    : mockIdentity(code);

  if (!identity.email) throw new ApiError(502, "Google did not return an email address");

  const email = identity.email.toLowerCase();
  const emailVerified = identity.email_verified === true;

  // The subject is the durable identifier; email is a mutable attribute.
  let user = (await User.findOne({ googleProviderId: identity.sub })) || (await User.findOne({ email }));

  if (user && !emailVerified) {
    // Refusing is the only safe option here: creating a second account would be
    // confusing, and linking on an address Google will not vouch for would let
    // whoever controls that Google account take over an existing one.
    throw new ApiError(
      403,
      `Google has not verified ${email}. Sign in with your password, or verify the address with Google and try again.`
    );
  }

  let isNewUser = false;

  if (user) {
    // Link the Google identity to the existing account. A local password login
    // keeps working, so `provider` is left alone.
    user.googleProviderId = identity.sub;
    user.googleEmail = email;
    if (!user.avatar && identity.picture) user.avatar = identity.picture;
    user.lastLoginAt = new Date();
    await user.save();
  } else {
    isNewUser = true;
    user = await User.create({
      name: identity.name || email.split("@")[0],
      email,
      // No password: this account signs in through Google only. `password` is
      // optional on the model, and `comparePassword` tolerates the absence.
      password: undefined,
      provider: "google",
      providerId: identity.sub,
      googleProviderId: identity.sub,
      googleEmail: email,
      emailVerified,
      avatar: identity.picture || null,
      lastLoginAt: new Date(),
    });
  }

  // A Google sign-in gets the same short-lived access token as every other
  // path; the refresh cookie that renews it is attached by the controller.
  return {
    token: signAccessToken(user),
    userId: String(user._id),
    isNewUser,
    emailVerified,
    returnTo: safeReturnTo(entry.returnTo),
    user: {
      // `id`, not `_id`: the local register and login responses use the same
      // shape, so the frontend can treat all three sign-in paths identically.
      id: user._id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      provider: user.provider || "local",
    },
  };
}

/**
 * Begin connecting Drive/Docs for a signed-in user.
 *
 * @param {string} userId
 * @param {string[]} groups Scope groups, e.g. `["drive", "docs"]`.
 * @returns {{url: string, mock: boolean}}
 */
export function startConnect(userId, groups) {
  const cfg = googleConfig();
  if (!isGoogleConfigured(cfg) && !cfg.allowMock) {
    throw new ApiError(503, "Google integration is not configured on this server.");
  }

  const { scopes, unknown } = resolveScopes(groups);
  if (!scopes.length || unknown.length) {
    throw new ApiError(
      400,
      `Unknown Google permission group: ${unknown.join(", ") || "(none requested)"}`
    );
  }

  const state = issueState({
    flow: "connect",
    groups: Array.isArray(groups) ? groups : [groups],
    userId: String(userId),
    returnTo: "/dashboard",
  });

  return {
    url: authorizeUrl({ state, groups, prompt: promptForAccessType(groups) }),
    mock: !isGoogleConfigured(cfg),
  };
}

/**
 * Finish connecting and store the encrypted refresh token.
 *
 * @param {{code: string, state: string}} params
 * @returns {Promise<object>} The connection, safe to serialise.
 */
export async function completeConnect({ code, state }) {
  if (!code) throw new ApiError(400, "Missing authorization code");
  const entry = consumeState(state);
  if (entry.flow !== "connect" || !entry.userId) {
    throw new ApiError(400, "This callback does not match the connect flow");
  }

  const cfg = googleConfig();
  const tokens = isGoogleConfigured(cfg) ? await exchangeCode(code) : mockExchange(code);

  let connection = await GoogleConnection.findOne({ user: entry.userId, provider: "google" });

  if (!connection) {
    connection = new GoogleConnection({ user: entry.userId, provider: "google" });
  }

  connection.groups = (entry.groups || []).join(" ");
  connection.scopes = tokens.scope || "";
  connection.revokedAt = null;
  connection.lastUsedAt = new Date();
  // Google only returns a refresh token on the first consent, or when
  // `prompt=consent` forced a new one. Keep the existing token otherwise,
  // otherwise a reconnect would silently break the integration.
  if (tokens.refresh_token) connection.setRefreshToken(tokens.refresh_token);

  // Show the connected account in the Integration Center, so a user can tell
  // *which* Google account is attached. This is cosmetic, so a failure to read
  // the profile must not discard an otherwise valid grant.
  const identity = isGoogleConfigured(cfg)
    ? await fetchIdentity(tokens.access_token).catch(() => null)
    : mockIdentity(code);
  if (identity?.email) {
    connection.email = identity.email.toLowerCase();
    connection.displayName = identity.name || null;
  }

  await connection.save();

  return describeConnection(connection);
}

/** The active connection for a user, or null. */
export async function getConnection(userId) {
  return GoogleConnection.findOne({ user: userId, provider: "google", revokedAt: null });
}

/** Serialisable, credential-free view of a connection. */
export function describeConnection(connection) {
  if (!connection) return null;
  return {
    provider: "google",
    connected: true,
    email: connection.email,
    displayName: connection.displayName,
    groups: connection.groupList,
    scopes: connection.scopeList,
    lastUsedAt: connection.lastUsedAt,
    connectedAt: connection.createdAt,
  };
}

/**
 * A usable access token for the connection, refreshed when it is close to
 * expiry. Callers should prefer `withAccessToken` so the connection's
 * `lastUsedAt` is kept current.
 *
 * @param {object} connection
 * @returns {Promise<string>}
 */
export async function withAccessToken(connection) {
  if (!connection) {
    throw new ApiError(412, "Google is not connected. Connect your account first.");
  }
  const refreshToken = connection.getRefreshToken();
  const cfg = googleConfig();

  if (!isGoogleConfigured(cfg) && cfg.allowMock) {
    // Mock connections have no real grant; a fake token keeps the Drive and Docs
    // layers on their mock path without a special case at every call site.
    return `mock-access-${connection.tokenHint || "token"}`;
  }

  const tokens = await refreshAccessToken(refreshToken);
  if (tokens.refresh_token) connection.setRefreshToken(tokens.refresh_token);
  connection.lastUsedAt = new Date();
  await connection.save();
  return tokens.access_token;
}

/** Whether a connection currently holds a group. */
export function connectionHas(connection, group) {
  return Boolean(connection?.groupList.includes(group));
}

/** Revoke at Google, then forget locally. */
export async function disconnect(userId) {
  const connection = await getConnection(userId);
  if (!connection) throw new ApiError(404, "Google is not connected");

  const cfg = googleConfig();
  if (isGoogleConfigured(cfg)) {
    const refreshToken = connection.getRefreshToken();
    // Best effort: a failure here must not block the local disconnect, otherwise
    // a user could be stuck with a grant they cannot see or remove.
    await fetch(cfg.revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    }).catch(() => {});
  }

  connection.refreshToken = null;
  connection.tokenHint = null;
  connection.scopes = "";
  connection.revokedAt = new Date();
  await connection.save();
  return { disconnected: true };
}

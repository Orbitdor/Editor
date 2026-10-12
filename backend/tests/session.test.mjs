/**
 * Session security (master plan section 8, section 37).
 *
 * Covers the four promises that section makes and the earlier build did not
 * keep: short-lived access tokens, rotating refresh tokens in HttpOnly cookies,
 * session management, and logout-all-devices.
 *
 * Usage (from backend/):
 *   TEST_FILTER=session npm test
 */
const API = process.env.API || "http://localhost:5051/api/v1";

let failures = 0;

function ok(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` -> ${extra}` : ""}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label} -> ${detail}`);
}
function check(label, condition, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

async function call(path, { method = "GET", token, cookie, body } = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Bounded so a request that never answers fails here instead of stalling the suite.
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    status: res.status,
    body: json,
    setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
  };
}

/** Pull `ae_at`/`ae_rt` out of a Set-Cookie list into a Cookie header string. */
function cookieJar(setCookies) {
  const jar = {};
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return (names) => names.map((n) => `${n}=${jar[n]}`).join("; ");
}

const stamp = Date.now().toString(36);
const alice = { name: "Session Alice", email: `sess.alice.${stamp}@test.local`, password: "Str0ngPass!" };
const bob = { name: "Session Bob", email: `sess.bob.${stamp}@test.local`, password: "Str0ngPass!" };

section("Sign-in issues HttpOnly cookies, not a token in storage");
const reg = await call("/auth/register", { method: "POST", body: alice });
check("registration succeeds", reg.status === 201, `status ${reg.status}`);

const cookies = reg.setCookie;
const accessCookie = cookies.find((c) => c.startsWith("ae_at="));
const refreshCookie = cookies.find((c) => c.startsWith("ae_rt="));
check("an access cookie is set", !!accessCookie, cookies.join(" | ") || "no Set-Cookie");
check("a refresh cookie is set", !!refreshCookie, "ae_rt missing");
check("the access cookie is HttpOnly", /HttpOnly/i.test(accessCookie || ""), accessCookie);
check("the refresh cookie is HttpOnly", /HttpOnly/i.test(refreshCookie || ""), refreshCookie);
check(
  "both cookies are SameSite=Strict",
  /SameSite=Strict/i.test(accessCookie || "") && /SameSite=Strict/i.test(refreshCookie || ""),
  `${accessCookie} ;; ${refreshCookie}`
);
check("the access cookie is short lived", /Max-Age=900/i.test(accessCookie || ""), accessCookie);

section("A cookie alone authenticates the API");
const jar = cookieJar(cookies);
const viaCookie = await call("/documents", { cookie: jar(["ae_at"]) });
check("the cookie works as a bearer", viaCookie.status === 200, `status ${viaCookie.status}`);
const viaBodyToken = await call("/documents", { token: reg.body.token });
check("the echoed token still works", viaBodyToken.status === 200, `status ${viaBodyToken.status}`);
const anon = await call("/documents");
check("no cookie and no token is rejected", anon.status === 401, `status ${anon.status}`);

section("Refresh rotates the token");
const firstRefresh = await call("/auth/refresh", { method: "POST", cookie: jar(["ae_rt"]) });
check("refresh succeeds", firstRefresh.status === 200, `status ${firstRefresh.status}`);
const rotated = cookieJar(firstRefresh.setCookie);
check("a new refresh cookie is issued", rotated(["ae_rt"]) !== jar(["ae_rt"]), "token was reused");
check("a new access cookie is issued", rotated(["ae_at"]) !== jar(["ae_at"]), "access token was reused");
const afterRotate = await call("/documents", { cookie: rotated(["ae_at"]) });
check("the rotated access cookie works", afterRotate.status === 200, `status ${afterRotate.status}`);

section("A replayed refresh token is caught and the chain dies");
const replay = await call("/auth/refresh", { method: "POST", cookie: jar(["ae_rt"]) });
check("the old token is refused", replay.status === 401, `status ${replay.status}`);
check(
  "the refusal names the reuse",
  /reuse/i.test(replay.body?.error || ""),
  replay.body?.error || "no error text"
);
const afterReplay = await call("/auth/refresh", { method: "POST", cookie: rotated(["ae_rt"]) });
check(
  "the successor session is revoked too",
  afterReplay.status === 401,
  `status ${afterReplay.status}`
);

section("Session management lists live devices");
await call("/auth/register", { method: "POST", body: bob });
const bobLogin = await call("/auth/login", { method: "POST", body: { email: bob.email, password: bob.password } });
const bobJar = cookieJar(bobLogin.setCookie);
// A real browser sends both cookies, and the device screen needs the refresh one
// to work out which row is the caller.
const both = (jar) => jar(["ae_at", "ae_rt"]);

// Alice signs in twice: the replay test above already killed her first session,
// so these are the only two live devices the list should show.
const aliceLogin = await call("/auth/login", { method: "POST", body: { email: alice.email, password: alice.password } });
const aliceJar = cookieJar(aliceLogin.setCookie);
const aliceOther = await call("/auth/login", { method: "POST", body: { email: alice.email, password: alice.password } });
const aliceOtherJar = cookieJar(aliceOther.setCookie);

const devices = await call("/auth/sessions", { cookie: both(aliceJar) });
check("both devices are listed", devices.status === 200 && devices.body.sessions.length === 2, `status ${devices.status}, ${devices.body?.sessions?.length} sessions`);
check(
  "the calling device is flagged",
  devices.body.sessions.some((s) => s.isCurrent),
  "no isCurrent flag"
);
check(
  "the other device is not flagged",
  devices.body.sessions.filter((s) => s.isCurrent).length === 1,
  `${devices.body.sessions.filter((s) => s.isCurrent).length} flagged`
);
check("sessions never expose the token", !/tokenHash|ae_rt/.test(JSON.stringify(devices.body)), "hash leaked");

section("Sign out one device, sign out all devices");
const target = devices.body.sessions.find((s) => !s.isCurrent);
const revoke = await call(`/auth/sessions/${target.id}`, { method: "DELETE", cookie: both(aliceJar) });
check("a session can be revoked by id", revoke.status === 200, `status ${revoke.status}`);
const stillLive = await call("/auth/sessions", { cookie: both(aliceJar) });
check("only the revoked device is gone", stillLive.body.sessions.length === devices.body.sessions.length - 1, `${stillLive.body?.sessions?.length} left`);
const strangerRevoke = await call(`/auth/sessions/${target.id}`, { method: "DELETE", cookie: both(bobJar) });
check("a user cannot revoke someone else's session", strangerRevoke.status === 404, `status ${strangerRevoke.status}`);
const revokedDeviceRefresh = await call("/auth/refresh", { method: "POST", cookie: aliceOtherJar(["ae_rt"]) });
check("the revoked device can no longer refresh", revokedDeviceRefresh.status === 401, `status ${revokedDeviceRefresh.status}`);

const logout = await call("/auth/logout", { method: "POST", cookie: both(aliceJar) });
check("logout succeeds", logout.status === 200, `status ${logout.status}`);
const afterLogout = await call("/auth/refresh", { method: "POST", cookie: aliceJar(["ae_rt"]) });
check("the logged-out session cannot refresh", afterLogout.status === 401, `status ${afterLogout.status}`);

const logoutAll = await call("/auth/logout-all", { method: "POST", cookie: both(bobJar) });
check("logout-all succeeds", logoutAll.status === 200, `status ${logoutAll.status}`);
check("logout-all reports the count", logoutAll.body.revoked >= 1, `${logoutAll.body?.revoked} revoked`);
const afterLogoutAll = await call("/auth/refresh", { method: "POST", cookie: bobJar(["ae_rt"]) });
check("no session survives logout-all", afterLogoutAll.status === 401, `status ${afterLogoutAll.status}`);
const afterAllSessions = await call("/auth/sessions", { cookie: both(bobJar) });
check("the device list is empty afterwards", afterAllSessions.body.sessions.length === 0, `${afterAllSessions.body?.sessions?.length} left`);

section("Access tokens are short lived");
const decoded = (tok) => {
  const part = tok.split(".")[1];
  return JSON.parse(Buffer.from(part, "base64url").toString());
};
const claims = decoded(aliceLogin.body.token);
const ttlSeconds = claims.exp - claims.iat;
check("an access token lives at most 30 minutes", ttlSeconds > 0 && ttlSeconds <= 1800, `${ttlSeconds}s`);
check("the access token carries no refresh material", !("refreshToken" in claims) && !("rt" in claims), Object.keys(claims).join(","));

console.log(failures ? `\n${failures} SESSION CHECK(S) FAILED` : "\nALL SESSION CHECKS PASSED");
process.exit(failures ? 1 : 0);
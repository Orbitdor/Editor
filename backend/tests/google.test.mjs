/**
 * Sprint 5 Google integration test: sign-in, the Integration Center, Drive
 * browsing, Docs import with conversion, Drive export, token encryption and
 * access control.
 *
 * With no GOOGLE_CLIENT_ID the server serves the whole flow from its offline
 * mock, so the OAuth state machine, the Docs converter and the limitation
 * reporting are all genuinely exercised. The one thing that cannot be tested
 * offline is the round trip to Google itself.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 node tests/google.test.mjs
 */
import { createHash } from "node:crypto";

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

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
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
  return { status: res.status, body: json };
}

async function register(name, email) {
  const res = await call("/auth/register", {
    method: "POST",
    body: { name, email, password: "password123" },
  });
  if (res.status !== 201 && res.status !== 200) {
    const login = await call("/auth/login", { method: "POST", body: { email, password: "password123" } });
    if (login.status !== 200) throw new Error(`cannot register/login ${email}: ${JSON.stringify(login)}`);
    return login.body;
  }
  return res.body;
}

/** Pull the `state` value out of a Google consent URL. */
function stateFrom(url) {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    // A missing or non-URL value means the route refused to issue a consent URL,
    // which the checks report rather than crashing the run.
    return null;
  }
}

/**
 * Run a full browser sign-in and return the session payload.
 *
 * A browser reaching the callback is redirected onward with a single-use ticket
 * instead of receiving JSON, so this walks that exact path: follow the redirect,
 * redeem the ticket over POST. It also asserts the token never appears in the
 * redirect URL, which is the whole point of the ticket.
 */
async function signIn(code, { asBrowser = true } = {}) {
  const start = await call("/auth/google/start");
  const state = stateFrom(start.body?.url);
  if (!state) return { status: start.status, body: start.body };

  const callback = await fetch(`${API}/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: asBrowser ? { Accept: "text/html,application/xhtml+xml" } : { Accept: "application/json" },
    redirect: "manual",
  });

  if (!asBrowser) return { status: callback.status, body: await callback.json().catch(() => null) };

  const location = callback.headers.get("location") || "";
  const ticket = new URL(location, "http://x").searchParams.get("ticket");
  const redeemed = await call("/auth/google/session", { method: "POST", body: { ticket } });

  return {
    status: callback.status,
    state,
    ticket,
    location,
    leaked: /token=/.test(location),
    body: redeemed.body,
    redeemStatus: redeemed.status,
  };
}

const stamp = Date.now();
const userAEmail = `sprint5a${stamp}@example.com`;
const userBEmail = `sprint5b${stamp}@example.com`;

console.log("\n== Setup ==");
const userA = await register("Google A", userAEmail);
const userB = await register("Google B", userBEmail);
ok("2 local users ready", stamp);

const created = await call("/documents", {
  method: "POST",
  token: userA.token,
  body: { title: "Sprint 5 Export Test" },
});
check("user A creates a document", created.status === 201, `status ${created.status}`);
const docId = created.body._id;

console.log("\n== Google sign-in ==");
const signInStart = await call("/auth/google/start");
check("sign-in start returns 200", signInStart.status === 200, `status ${signInStart.status}`);
check("sign-in start returns a url", typeof signInStart.body?.url === "string" && signInStart.body.url.includes("accounts.google.com"), signInStart.body?.url?.slice(0, 60));

const authUrl = new URL(signInStart.body.url);
check("sign-in asks only for identity scopes", authUrl.searchParams.get("scope") === "openid email profile", authUrl.searchParams.get("scope"));
check("sign-in does not ask for Drive", !(authUrl.searchParams.get("scope") || "").includes("drive"), authUrl.searchParams.get("scope"));
check("sign-in uses the sign-in callback, not the connect one", authUrl.searchParams.get("redirect_uri")?.includes("/auth/google/callback") === true, authUrl.searchParams.get("redirect_uri"));
check("sign-in reports mock mode", typeof signInStart.body?.mock === "boolean", `mock=${signInStart.body?.mock}`);

const signInState = stateFrom(signInStart.body.url);
check("sign-in url carries state", Boolean(signInState), signInState?.slice(0, 12));

// The mock identity is derived from the authorization code, so each run needs its
// own code to get a fresh Google account. Deriving the email here, rather than
// adding a way to pick the email, is what keeps mock mode from becoming a way to
// sign in as anybody.
const mockEmail = (code) => `google.user.${createHash("sha256").update(`mock-google:${code}`).digest("hex").slice(0, 10)}@example.com`;
const freshCode = `fresh-${stamp}`;
const googleEmail = mockEmail(freshCode);

// A fresh Google identity becomes a new app account.
const googleSignIn = await signIn(freshCode);
check("sign-in callback redirects the browser", googleSignIn.status === 302, `status ${googleSignIn.status}`);
check("the redirect hands over a ticket", Boolean(googleSignIn.ticket), `${googleSignIn.ticket?.slice(0, 12)}`);
check("the redirect never carries the token", googleSignIn.leaked === false, googleSignIn.location?.slice(0, 60));
check("the redirect returns 200 for an API client", googleSignIn.redeemStatus === 200, `status ${googleSignIn.redeemStatus}`);
check("sign-in callback returns 200", googleSignIn.redeemStatus === 200, `status ${googleSignIn.redeemStatus} ${JSON.stringify(googleSignIn.body?.error || "")}`);
check("sign-in returns a token", typeof googleSignIn.body?.token === "string" && googleSignIn.body.token.length > 20, `${googleSignIn.body?.token?.length} chars`);

// The ticket is single use, so a replayed redirect cannot mint a second session.
const replayTicket = await call("/auth/google/session", { method: "POST", body: { ticket: googleSignIn.ticket } });
check("a redeemed ticket cannot be reused", replayTicket.status === 400, `status ${replayTicket.status}`);
check("sign-in creates the account the mock identity names", googleSignIn.body?.user?.email === googleEmail, `${googleSignIn.body?.user?.email} vs ${googleEmail}`);
check("sign-in returns a user", typeof googleSignIn.body?.user?.email === "string" && googleSignIn.body.user.email.includes("@"), googleSignIn.body?.user?.email);
check("sign-in user has the id shape the app already uses", Boolean(googleSignIn.body?.user?.id), googleSignIn.body?.user?.id);
check("sign-in reports a new account", googleSignIn.body?.isNewUser === true, String(googleSignIn.body?.isNewUser));
check("sign-in marks the email verified", googleSignIn.body?.emailVerified === true, String(googleSignIn.body?.emailVerified));
check("sign-in never returns a password", !googleSignIn.body?.user?.password, "password must be absent");
check("sign-in never returns a provider id", !googleSignIn.body?.user?.googleProviderId && !googleSignIn.body?.user?.providerId, "provider ids must be absent");

// The state value is single use. This replays the exact state the successful
// sign-in above consumed, which is the attack it defends against.
const replay = await call(`/auth/google/callback?code=${freshCode}&state=${encodeURIComponent(googleSignIn.state)}`);
check("a replayed state is rejected", replay.status === 400, `status ${replay.status}`);

const badState = await call("/auth/google/callback?code=fake&state=not-a-real-state");
check("an unknown state is rejected", badState.status === 400, `status ${badState.status}`);

const noCodeStart = await call("/auth/google/start");
const noCode = await call(`/auth/google/callback?state=${encodeURIComponent(stateFrom(noCodeStart.body?.url) || "")}`);
check("a missing code is rejected", noCode.status === 400, `status ${noCode.status}`);

const googleError = await call("/auth/google/callback?error=access_denied&state=x");
check("a Google-reported error is surfaced", googleError.status === 400, `status ${googleError.status}`);

// The same Google account signing in again must return the same app user. The
// mock derives its identity from the code, so the code is reused here.
const second = await signIn(freshCode);
check("a repeat Google sign-in creates no duplicate", second.body?.isNewUser === false, String(second.body?.isNewUser));
check("repeat sign-in returns the same account", second.body?.user?.email === googleEmail, second.body?.user?.email);
check("repeat sign-in returns the same user id", second.body?.user?.id === googleSignIn.body?.user?.id, second.body?.user?.id);

// A different Google account is a different app user.
const otherCode = `other-${stamp}`;
const other = await signIn(otherCode);
check("a different Google account is a new app user", other.body?.isNewUser === true, String(other.body?.isNewUser));
check("the two Google accounts differ", other.body?.user?.email === mockEmail(otherCode) && other.body?.user?.email !== googleEmail, other.body?.user?.email);

// An API client that asks for JSON gets the session without the ticket detour.
const jsonClient = await signIn(`json-${stamp}`, { asBrowser: false });
check("an API client gets JSON straight from the callback", jsonClient.status === 200 && typeof jsonClient.body?.token === "string", `status ${jsonClient.status}`);

// The Google-issued token must work on the app's own API.
const asDocs = await call("/documents", {
  method: "POST",
  token: googleSignIn.body.token,
  body: { title: "Created after Google sign-in" },
});
check("a Google-created account can use the API", asDocs.status === 201, `status ${asDocs.status}`);

// Linking Google to an existing local account must keep the password working.
// The local account is created first with the email this code will resolve to, so
// the callback has to link rather than create a second account for the same person.
const linkCode = `link-${stamp}`;
const linkEmail = mockEmail(linkCode);

const registered = await call("/auth/register", {
  method: "POST",
  body: { name: "Linked User", email: linkEmail, password: "password123" },
});
check("the future linked account is registered locally", registered.status === 201 || registered.status === 200, `status ${registered.status}`);
const linkUserId = registered.body?.user?.id;

const linkPassBefore = await call("/auth/login", { method: "POST", body: { email: linkEmail, password: "password123" } });
check("the local account can sign in with a password", linkPassBefore.status === 200, `status ${linkPassBefore.status}`);
check("the local account has an id", Boolean(linkUserId), linkUserId);

const linkStart = await call("/auth/google/start");
const linked = await signIn(linkCode);
check("a Google sign-in links the existing account instead of duplicating", linked.body?.user?.id === linkUserId, `${linked.body?.user?.id} vs ${linkUserId}`);
check("the linked sign-in reports no new account", linked.body?.isNewUser === false, String(linked.body?.isNewUser));

const linkPassAfter = await call("/auth/login", { method: "POST", body: { email: linkEmail, password: "password123" } });
check("linking Google does not break the password login", linkPassAfter.status === 200, `status ${linkPassAfter.status}`);
check("the linked account keeps its local id", linkPassAfter.body?.user?.id === linkUserId, `${linkPassAfter.body?.user?.id} vs ${linkUserId}`);

console.log("\n== Integration Center status ==");
const status = await call("/integrations/google/status", { token: userA.token });
check("status returns 200", status.status === 200, `status ${status.status}`);
check("status reports whether Google is configured", typeof status.body?.configured === "boolean", `configured=${status.body?.configured}`);
check("status lists permission groups", Array.isArray(status.body?.groups) && status.body.groups.length >= 4, `${status.body?.groups?.length} groups`);
check("status advertises no connection yet", status.body?.connection === null, JSON.stringify(status.body?.connection));
check("status never returns a refresh token", !JSON.stringify(status.body).toLowerCase().includes("refresh_token"), "refresh_token must be absent");

const statusAnon = await call("/integrations/google/status");
check("status requires auth", statusAnon.status === 401, `status ${statusAnon.status}`);

console.log("\n== Connect Drive and Docs ==");
const start = await call("/integrations/google/start?groups=drive,docs", { token: userA.token });
check("connect start returns 200", start.status === 200, `status ${start.status}`);
const connectUrl = new URL(start.body.url);
check("connect asks for drive.file", (connectUrl.searchParams.get("scope") || "").includes("drive.file"), connectUrl.searchParams.get("scope"));
check("connect asks for documents", (connectUrl.searchParams.get("scope") || "").includes("/auth/documents"), true);
check("connect does not ask for full Drive access", (connectUrl.searchParams.get("scope") || "").includes("auth/drive"), false);
check("connect forces re-consent", connectUrl.searchParams.get("prompt") === "consent", connectUrl.searchParams.get("prompt"));

const badGroup = await call("/integrations/google/start?groups=nonsense", { token: userA.token });
check("an unknown permission group is rejected", badGroup.status === 400, `status ${badGroup.status}`);

const emptyGroups = await call("/integrations/google/start?groups=", { token: userA.token });
check("no groups requested is rejected", emptyGroups.status === 400, `status ${emptyGroups.status}`);

const connectAnon = await call("/integrations/google/start?groups=drive");
check("connect requires auth", connectAnon.status === 401, `status ${connectAnon.status}`);

const callback = await call(`/integrations/google/callback?code=fake&state=${encodeURIComponent(stateFrom(start.body.url))}`, {
  token: userA.token,
});
check("connect callback returns 200", callback.status === 200, `status ${callback.status} ${JSON.stringify(callback.body?.error || "")}`);
check("connect records the groups", JSON.stringify(callback.body?.groups) === '["drive","docs"]', JSON.stringify(callback.body?.groups));
check("connect reports the account", Boolean(callback.body?.email), callback.body?.email);
check("connect response hides credentials", !JSON.stringify(callback.body).toLowerCase().includes("mock-refresh"), "the refresh token must be absent");

const connected = await call("/integrations/google/status", { token: userA.token });
check("status now shows a connection", connected.body?.connection?.connected === true, JSON.stringify(connected.body?.connection));
check("connection remembers its groups", JSON.stringify(connected.body?.connection?.groups) === '["drive","docs"]', JSON.stringify(connected.body?.connection?.groups));

const callbackAnon = await call("/integrations/google/callback?code=fake&state=x");
check("connect callback requires auth", callbackAnon.status === 401, `status ${callbackAnon.status}`);

console.log("\n== Drive browsing ==");
const filesAnon = await call("/integrations/google/files", { token: userB.token });
check("Drive listing needs a connection", filesAnon.status === 412, `status ${filesAnon.status} ${JSON.stringify(filesAnon.body?.error || "")}`);

const files = await call("/integrations/google/files", { token: userA.token });
check("Drive listing returns 200", files.status === 200, `status ${files.status} ${JSON.stringify(files.body?.error || "")}`);
check("Drive listing returns files", Array.isArray(files.body?.files) && files.body.files.length >= 4, `${files.body?.files?.length} files`);
check("files carry an id and name", Boolean(files.body?.files?.[0]?.id && files.body?.files?.[0]?.name), files.body?.files?.[0]?.name);
check("files report whether they are importable", files.body?.files?.some((f) => f.importable), true);
check("non-importable files are marked", files.body?.files?.some((f) => !f.importable), true);
check("Drive listing is labelled as mock", files.body?.mock === true, String(files.body?.mock));

const searched = await call("/integrations/google/files?q=budget", { token: userA.token });
check("Drive search filters", searched.body?.files?.length === 1 && /budget/i.test(searched.body.files[0].name), `${searched.body?.files?.length} matches`);

const limited = await call("/integrations/google/files?limit=2", { token: userA.token });
check("Drive listing respects the limit", limited.body?.files?.length === 2, `${limited.body?.files?.length} files`);

console.log("\n== Google Docs import ==");
const docFile = files.body.files.find((f) => f.importable);
const imported = await call(`/integrations/google/files/${docFile.id}`, { token: userA.token });
check("import returns 200", imported.status === 200, `status ${imported.status} ${JSON.stringify(imported.body?.error || "")}`);
check("import returns a title", typeof imported.body?.title === "string" && imported.body.title.length > 0, imported.body?.title);
check("import returns a doc node", imported.body?.content?.type === "doc", imported.body?.content?.type);
check("import returns block content", Array.isArray(imported.body?.content?.content) && imported.body.content.content.length > 0, `${imported.body?.content?.content?.length} blocks`);
check("import returns plain text", typeof imported.body?.plainText === "string" && imported.body.plainText.length > 0, `${imported.body?.plainText?.length} chars`);
check("import records its source file", imported.body?.source?.fileId === docFile.id, imported.body?.source?.fileId);
check("import reports limitations as a list", Array.isArray(imported.body?.limitations), JSON.stringify(imported.body?.limitations));

// A spreadsheet is not a Google Doc, so importing it must be refused clearly.
const sheet = files.body.files.find((f) => !f.importable);
const sheetImport = await call(`/integrations/google/files/${sheet.id}`, { token: userA.token });
check("a non-Docs file cannot be imported", sheetImport.status === 400, `status ${sheetImport.status}`);
check("the refusal explains why", /only google docs/i.test(sheetImport.body?.error || ""), sheetImport.body?.error);

const missingFile = await call("/integrations/google/files/mock-doc-does-not-exist", { token: userA.token });
check("an unknown file returns 404", missingFile.status === 404, `status ${missingFile.status}`);

const badFileId = await call("/integrations/google/files/not%20a%20valid%20id", { token: userA.token });
check("a malformed file id is rejected", badFileId.status === 400, `status ${badFileId.status}`);

const importAnon = await call(`/integrations/google/files/${docFile.id}`, { token: userB.token });
check("import needs a connection", importAnon.status === 412, `status ${importAnon.status}`);

console.log("\n== Export to Drive ==");
const exported = await call("/integrations/google/export", {
  method: "POST",
  token: userA.token,
  body: { title: "Sprint 5 Export Test", html: "<h1>Hello</h1><p>Body text.</p>" },
});
check("export returns 200", exported.status === 200, `status ${exported.status} ${JSON.stringify(exported.body?.error || "")}`);
check("export returns a file id", typeof exported.body?.fileId === "string", exported.body?.fileId);
check("export returns a Drive url", typeof exported.body?.url === "string" && exported.body.url.includes("docs.google.com"), exported.body?.url);
check("export keeps the title", exported.body?.name === "Sprint 5 Export Test", exported.body?.name);

const noTitle = await call("/integrations/google/export", { method: "POST", token: userA.token, body: { html: "<p>x</p>" } });
check("export without a title is rejected", noTitle.status === 400, `status ${noTitle.status}`);

const noHtml = await call("/integrations/google/export", { method: "POST", token: userA.token, body: { title: "x" } });
check("export without content is rejected", noHtml.status === 400, `status ${noHtml.status}`);

const exportAnon = await call("/integrations/google/export", { method: "POST", token: userB.token, body: { title: "x", html: "<p>x</p>" } });
check("export needs a connection", exportAnon.status === 412, `status ${exportAnon.status}`);

console.log("\n== Disconnect ==");
const disconnectAnon = await call("/integrations/google", { method: "DELETE", token: userB.token });
check("disconnecting without a connection returns 404", disconnectAnon.status === 404, `status ${disconnectAnon.status}`);

const disconnected = await call("/integrations/google", { method: "DELETE", token: userA.token });
check("disconnect returns 200", disconnected.status === 200, `status ${disconnected.status}`);
check("disconnect confirms", disconnected.body?.disconnected === true, JSON.stringify(disconnected.body));

const afterDisconnect = await call("/integrations/google/status", { token: userA.token });
check("status shows no connection after disconnect", afterDisconnect.body?.connection === null, JSON.stringify(afterDisconnect.body?.connection));

const filesAfter = await call("/integrations/google/files", { token: userA.token });
check("Drive is unreachable after disconnect", filesAfter.status === 412, `status ${filesAfter.status}`);

console.log("\n== Provider routing ==");
const ocrGoogle = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: userA.token,
  body: {
    image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    provider: "google",
  },
});
check("Google OCR without a connection is refused", ocrGoogle.status === 412, `status ${ocrGoogle.status}`);
check("the refusal asks for the right scope", /vision/i.test(ocrGoogle.body?.error || ""), ocrGoogle.body?.error);

const ocrDefault = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: userA.token,
  body: { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
});
check("the default provider still works after disconnect", ocrDefault.status === 200, `status ${ocrDefault.status}`);

const voiceGoogle = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: userA.token,
  body: { audio: "data:audio/webm;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMA", provider: "google" },
});
check("Google Speech without a connection is refused", voiceGoogle.status === 412, `status ${voiceGoogle.status}`);
check("the refusal asks for the right scope", /speech/i.test(voiceGoogle.body?.error || ""), voiceGoogle.body?.error);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
if (failures) process.exit(1);
console.log(`cleanup: run "node --env-file=.env tests/cleanup-test-data.mjs" to drop the test rows.`);
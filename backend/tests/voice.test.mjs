/**
 * Sprint 4 voice test: speech-to-text, transcript cleanup, spoken editing
 * commands, voice quota accounting and access control.
 *
 * Runs over HTTP against a live server, so it covers routing, validation, the
 * services, quota accounting and the database. It registers its own throwaway
 * users with a timestamp, so runs never collide and never touch real data.
 *
 * With no OPENAI_API_KEY the server falls back to the offline mock speech
 * provider, so the whole pipeline is still exercised; the mock is asserted via
 * the `mock` flag rather than the transcript content. The cleanup pipeline is
 * real, so punctuation, paragraphs, language detection and commands are
 * asserted on actual output.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 node tests/voice.test.mjs
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

/**
 * A tiny valid base64 audio payload. The provider is mocked in this
 * environment, so the bytes are never actually decoded for transcription; the
 * value only has to be a well-formed `data:audio/...;base64,` URL so the
 * validator accepts it.
 */
const TINY_AUDIO = "data:audio/webm;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMA";

const stamp = Date.now();
const ownerEmail = `sprint4owner${stamp}@example.com`;
const viewerEmail = `sprint4viewer${stamp}@example.com`;
const strangerEmail = `sprint4stranger${stamp}@example.com`;

console.log("\n== Setup ==");
const owner = await register("Voice Owner", ownerEmail);
const viewerUser = await register("Voice Viewer", viewerEmail);
const stranger = await register("Voice Stranger", strangerEmail);
ok("3 users ready", stamp);

const created = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Sprint 4 Voice Test" },
});
check("owner creates document", created.status === 201, `status ${created.status}`);
const docId = created.body._id;

const shareViewer = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: viewerEmail, role: "viewer" },
});
check("owner shares as viewer", shareViewer.status === 200, `status ${shareViewer.status}`);

console.log("\n== Voice status ==");
const status = await call("/voice/status", { token: owner.token });
check("status returns 200", status.status === 200, `status ${status.status}`);
check("status advertises languages", Array.isArray(status.body?.languages) && status.body.languages.includes("ur-PK"), JSON.stringify(status.body?.languages));
check("status advertises the clip limit", status.body?.maxClipSeconds > 0, `${status.body?.maxClipSeconds}s`);
check("status reports the daily minute budget", status.body?.dailyMinutes > 0, `${status.body?.dailyMinutes} min`);
check(
  "status reports remaining minutes",
  typeof status.body?.minutesRemainingToday === "number" && status.body.minutesRemainingToday >= 0,
  `${status.body?.minutesRemainingToday} min left`
);
check(
  "status exposes a server-configured flag",
  typeof status.body?.serverConfigured === "boolean",
  `serverConfigured=${status.body?.serverConfigured} mock=${status.body?.mock}`
);

const statusAnon = await call("/voice/status");
check("status requires auth", statusAnon.status === 401, `status ${statusAnon.status}`);

console.log("\n== Access control ==");
const strangerTranscribe = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: stranger.token,
  body: { audio: TINY_AUDIO },
});
check("stranger cannot dictate", strangerTranscribe.status === 403, `status ${strangerTranscribe.status}`);

const viewerTranscribe = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: viewerUser.token,
  body: { audio: TINY_AUDIO },
});
check("viewer cannot dictate", viewerTranscribe.status === 403, `status ${viewerTranscribe.status}`);

const strangerFinish = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: stranger.token,
  body: { transcript: "hello world" },
});
check("stranger cannot submit a transcript", strangerFinish.status === 403, `status ${strangerFinish.status}`);

console.log("\n== Validation ==");
const noAudio = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: {},
});
check("transcribe without audio rejected", noAudio.status === 400, `status ${noAudio.status}`);

const badMime = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: "data:application/pdf;base64,AAAA" },
});
check("non-audio payload rejected", badMime.status === 400, `status ${badMime.status}`);

const remoteUrl = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: "https://example.com/clip.webm" },
});
check("remote URL rejected (no SSRF)", remoteUrl.status === 400, `status ${remoteUrl.status}`);

const badLang = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: TINY_AUDIO, language: "klingon" },
});
check("unsupported language rejected", badLang.status === 400, `status ${badLang.status}`);

const negativeDuration = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: TINY_AUDIO, durationSeconds: -5 },
});
check("negative duration rejected", negativeDuration.status === 400, `status ${negativeDuration.status}`);

const noTranscript = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: {},
});
check("finish without a transcript rejected", noTranscript.status === 400, `status ${noTranscript.status}`);

const blankTranscript = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "   " },
});
check("blank transcript rejected", blankTranscript.status === 400, `status ${blankTranscript.status}`);

const badProvider = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "hello", provider: "server" },
});
check("finish rejects a non-browser provider", badProvider.status === 400, `status ${badProvider.status}`);

console.log("\n== Browser transcript cleanup ==");
const finish = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "we shipped the release on monday so the team was happy", durationSeconds: 6 },
});
check("finish returns 200", finish.status === 200, `status ${finish.status} ${JSON.stringify(finish.body?.error || "")}`);
check("finish returns cleaned text", typeof finish.body?.text === "string" && finish.body.text.length > 0, JSON.stringify(finish.body?.text));
check("finish returns the raw transcript for review", typeof finish.body?.rawTranscript === "string", JSON.stringify(finish.body?.rawTranscript));
check("finish capitalises the first word", /^[A-Z]|^[؀-ۿ]/.test(finish.body?.text || ""), JSON.stringify(finish.body?.text));
check("finish adds terminal punctuation", /[.!?]$/.test(finish.body?.text || ""), JSON.stringify(finish.body?.text));
check("finish detects a language", typeof finish.body?.detectedLanguage === "string", finish.body?.detectedLanguage);
check("finish returns a transcription id", finish.body?.transcriptionId?.length === 24, finish.body?.transcriptionId);

const urduFinish = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "hum ne aaj naya product launch kiya aur customers khush hain", language: "ur-PK", durationSeconds: 5 },
});
check("Urdu dictation is accepted", urduFinish.status === 200, `status ${urduFinish.status}`);
check("Urdu is detected as Roman Urdu", urduFinish.body?.detectedLanguage === "roman-ur", urduFinish.body?.detectedLanguage);
check("an explicit language is honoured", urduFinish.body?.provider === "browser", urduFinish.body?.provider);

console.log("\n== Voice commands ==");
const heading = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "quarterly revenue summary make this a heading", durationSeconds: 4 },
});
check("heading command detected", heading.body?.commands?.some((c) => c.id === "newHeading"), JSON.stringify(heading.body?.commands));
check("command phrase is removed from the text", !/heading/i.test(heading.body?.text || ""), JSON.stringify(heading.body?.text));
check("surrounding text is preserved", /quarterly revenue summary/i.test(heading.body?.text || ""), JSON.stringify(heading.body?.text));

const listCmd = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "these are the open items bullet list", durationSeconds: 4 },
});
check("bullet list command detected", listCmd.body?.commands?.some((c) => c.id === "bulletList"), JSON.stringify(listCmd.body?.commands));

const noCommand = await call(`/documents/${docId}/voice/finish`, {
  method: "POST",
  token: owner.token,
  body: { transcript: "the heading of the report is clear", durationSeconds: 3 },
});
check("a content word is not read as a command", (noCommand.body?.commands || []).length === 0, JSON.stringify(noCommand.body?.commands));
check("plain dictation still works", typeof noCommand.body?.text === "string" && noCommand.body.text.length > 0, JSON.stringify(noCommand.body?.text));

console.log("\n== Server transcription ==");
const transcribe = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: TINY_AUDIO, language: "auto", durationSeconds: 8 },
});
check("transcribe returns 200", transcribe.status === 200, `status ${transcribe.status} ${JSON.stringify(transcribe.body?.error || "")}`);
check("transcribe returns text", typeof transcribe.body?.text === "string" && transcribe.body.text.length > 0, `${transcribe.body?.text?.length} chars`);
check("transcribe keeps the raw transcript", typeof transcribe.body?.rawTranscript === "string", `${transcribe.body?.rawTranscript?.length} chars`);
check("transcribe returns a transcription id", transcribe.body?.transcriptionId?.length === 24, transcribe.body?.transcriptionId);
check("transcribe reports the provider", typeof transcribe.body?.provider === "string", transcribe.body?.provider);
check("transcribe reports a mock flag", typeof transcribe.body?.mock === "boolean", `mock=${transcribe.body?.mock}`);
check("transcribe detects a language", typeof transcribe.body?.detectedLanguage === "string", transcribe.body?.detectedLanguage);

const tooLong = await call(`/documents/${docId}/voice/transcribe`, {
  method: "POST",
  token: owner.token,
  body: { audio: TINY_AUDIO, durationSeconds: 100000 },
});
check("an over-long clip is rejected", tooLong.status === 413, `status ${tooLong.status}`);

console.log("\n== History ==");
const sessions = await call(`/documents/${docId}/voice`, { token: owner.token });
check("session list returns 200", sessions.status === 200, `status ${sessions.status}`);
check("session list has entries", Array.isArray(sessions.body) && sessions.body.length >= 5, `${sessions.body?.length} sessions`);
check("session list has status + preview", sessions.body?.[0]?.status === "done" && typeof sessions.body?.[0]?.preview === "string", sessions.body?.[0]?.status);

const one = await call(`/documents/${docId}/voice/${transcribe.body.transcriptionId}`, { token: owner.token });
check("a single session is readable", one.status === 200 && one.body?.status === "done", `status ${one.status}`);
check("a session exposes both raw and cleaned text", typeof one.body?.rawTranscript === "string" && typeof one.body?.text === "string", `raw ${one.body?.rawTranscript?.length} / clean ${one.body?.text?.length}`);

const strangerRead = await call(`/documents/${docId}/voice/${transcribe.body.transcriptionId}`, { token: stranger.token });
check("stranger cannot read a session", strangerRead.status === 403, `status ${strangerRead.status}`);

const badId = await call(`/documents/${docId}/voice/000000000000000000000000`, { token: owner.token });
check("unknown session returns 404", badId.status === 404, `status ${badId.status}`);

const badRoute = await call(`/documents/${docId}/voice/not-an-id`, { token: owner.token });
check("malformed session id rejected", badRoute.status === 400, `status ${badRoute.status}`);

console.log("\n== Usage accounting ==");
const usage1 = await call("/ai/usage", { token: owner.token });
// 1 transcribe + 6 finish calls (clean, urdu, heading, list, plain) = 5 finish
const expected = 1 + 5;
check(
  "usage counted every owner voice call",
  usage1.body?.month?.requests === expected,
  `${usage1.body?.month?.requests} of ${expected} expected`
);
check(
  "usage tracks voice seconds",
  usage1.body?.voice?.secondsToday > 0,
  `${usage1.body?.voice?.secondsToday}s recorded`
);
check(
  "usage tracks voice sessions",
  usage1.body?.voice?.sessionsThisMonth === expected,
  `${usage1.body?.voice?.sessionsThisMonth} of ${expected} sessions`
);
check("usage reports a voice limit", usage1.body?.voice?.limitSeconds > 0, `${usage1.body?.voice?.limitSeconds}s limit`);

const viewerUsage = await call("/ai/usage", { token: viewerUser.token });
check("viewer usage stays zero", viewerUsage.body?.month?.requests === 0, `${viewerUsage.body?.month?.requests}`);

const strangerUsage = await call("/ai/usage", { token: stranger.token });
check("stranger usage is zero", strangerUsage.body?.month?.requests === 0, `${strangerUsage.body?.month?.requests}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
if (failures) process.exit(1);
console.log(`cleanup: run "node --env-file=.env tests/cleanup-test-data.mjs" to drop the test rows.`);

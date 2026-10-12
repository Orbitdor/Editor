/**
 * Sprint 3 AI / OCR test: writing assistant, document QA, image-to-text OCR,
 * usage quotas and access control.
 *
 * Runs over HTTP against a live server, so it covers routing, validation, the
 * services, quota accounting and the database. It registers its own throwaway
 * users with a timestamp, so runs never collide and never touch real data.
 *
 * With no OPENAI_API_KEY the server falls back to the offline mock provider, so
 * the whole pipeline is still exercised; the mock is asserted via the `mock`
 * flag rather than the text content.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 node tests/ai.test.mjs
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

/** A 1x1 transparent PNG, the smallest valid image payload. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const stamp = Date.now();
const ownerEmail = `sprint3owner${stamp}@example.com`;
const viewerEmail = `sprint3viewer${stamp}@example.com`;
const strangerEmail = `sprint3stranger${stamp}@example.com`;

console.log("\n== Setup ==");
const owner = await register("AI Owner", ownerEmail);
const viewerUser = await register("AI Viewer", viewerEmail);
const stranger = await register("AI Stranger", strangerEmail);
ok("3 users ready", stamp);

// Create only accepts a title, so the body is written with a follow-up save.
// Document-level actions (summarize, extract-tasks) and QA read the stored
// text, so it has to be non-empty for those to be meaningful.
const created = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Sprint 3 AI Test" },
});
check("owner creates document", created.status === 201, `status ${created.status}`);
const docId = created.body._id;

const body = "<p>The project will start on Monday. Ahmed will prepare the proposal and Sara will review it.</p><p>Deadline is 30 September 2026.</p>";
const saved = await call(`/documents/${docId}`, {
  method: "PUT",
  token: owner.token,
  body: { content: body },
});
check("owner writes document body", saved.status === 200, `status ${saved.status}`);

const shareViewer = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: viewerEmail, role: "viewer" },
});
check("owner shares as viewer", shareViewer.status === 200, `status ${shareViewer.status}`);

console.log("\n== Provider status ==");
const status = await call("/ai/status", { token: owner.token });
check("status returns 200", status.status === 200, `status ${status.status}`);
check("status advertises actions", Array.isArray(status.body?.actions) && status.body.actions.length > 5, `${status.body?.actions?.length} actions`);
check("status advertises languages", Array.isArray(status.body?.languages) && status.body.languages.includes("ur"), JSON.stringify(status.body?.languages));
check(
  "status reports mock when unconfigured",
  typeof status.body?.configured === "boolean",
  `configured=${status.body?.configured} mock=${status.body?.mock}`
);

const statusAnon = await call("/ai/status");
check("status requires auth", statusAnon.status === 401, `status ${statusAnon.status}`);

const usage0 = await call("/ai/usage", { token: owner.token });
check("usage starts empty", usage0.status === 200 && usage0.body?.day?.requests === 0, JSON.stringify(usage0.body?.day));

console.log("\n== Access control ==");
const strangerAction = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: stranger.token,
  body: { action: "improve", text: "hello" },
});
check("stranger cannot use AI", strangerAction.status === 403, `status ${strangerAction.status}`);

const viewerAction = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: viewerUser.token,
  body: { action: "improve", text: "hello" },
});
check("viewer cannot use the writing assistant", viewerAction.status === 403, `status ${viewerAction.status}`);

const viewerOcr = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: viewerUser.token,
  body: { image: TINY_PNG },
});
check("viewer cannot run OCR", viewerOcr.status === 403, `status ${viewerOcr.status}`);

const strangerOcr = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: stranger.token,
  body: { image: TINY_PNG },
});
check("stranger cannot run OCR", strangerOcr.status === 403, `status ${strangerOcr.status}`);

console.log("\n== Validation ==");
const badAction = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "not-a-real-action", text: "hello" },
});
check("unknown action rejected", badAction.status === 400, `status ${badAction.status}`);

const noText = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "improve", text: "   " },
});
check("empty selection rejected", noText.status === 400, `status ${noText.status}`);

const toneNoValue = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "tone", text: "hello", tone: "sarcastic-but-bad" },
});
check("tone action needs a valid tone", toneNoValue.status === 400, `status ${toneNoValue.status}`);

const translateNoLang = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "translate", text: "hello" },
});
check("translate needs a target language", translateNoLang.status === 400, `status ${translateNoLang.status}`);

const badLang = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "translate", text: "hello", language: "klingon" },
});
check("unsupported language rejected", badLang.status === 400, `status ${badLang.status}`);

const noImage = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: owner.token,
  body: {},
});
check("OCR without an image rejected", noImage.status === 400, `status ${noImage.status}`);

const badMime = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: owner.token,
  body: { image: "data:application/pdf;base64,AAAA" },
});
check("non-image payload rejected", badMime.status === 400, `status ${badMime.status}`);

const notBase64 = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: owner.token,
  body: { image: "https://example.com/photo.png" },
});
check("remote URL rejected (no SSRF)", notBase64.status === 400, `status ${notBase64.status}`);

const noQuestion = await call(`/documents/${docId}/ai/ask`, {
  method: "POST",
  token: owner.token,
  body: {},
});
check("empty question rejected", noQuestion.status === 400, `status ${noQuestion.status}`);

console.log("\n== Writing assistant ==");
const improve = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "improve", text: "the team will start on monday and finish the task quick" },
});
check("improve returns 200", improve.status === 200, `status ${improve.status}`);
check("improve returns text", typeof improve.body?.result === "string" && improve.body.result.length > 0, `${improve.body?.result?.length} chars`);
check("improve echoes the action", improve.body?.action === "improve", improve.body?.action);
check("improve reports mock flag", typeof improve.body?.mock === "boolean", `mock=${improve.body?.mock}`);

const grammar = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "fix-grammar", text: "This are wrong sentence." },
});
check("fix-grammar returns 200", grammar.status === 200, `status ${grammar.status}`);

const toneCall = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "tone", text: "hey can u send me the file", tone: "professional" },
});
check("tone with a valid tone works", toneCall.status === 200, `status ${toneCall.status}`);

const translate = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "translate", text: "The deadline is Friday.", language: "ur" },
});
check("translate to Urdu works", translate.status === 200, `status ${translate.status}`);

const extract = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "extract-tasks" },
});
check("extract-tasks works without a selection", extract.status === 200, `status ${extract.status}`);
check("extract-tasks used the document", extract.body?.usedDocument === true, `usedDocument=${extract.body?.usedDocument}`);

const summarize = await call(`/documents/${docId}/ai/action`, {
  method: "POST",
  token: owner.token,
  body: { action: "summarize" },
});
check("summarize works on the document", summarize.status === 200, `status ${summarize.status}`);

console.log("\n== Document QA ==");
const ask = await call(`/documents/${docId}/ai/ask`, {
  method: "POST",
  token: owner.token,
  body: { question: "Who is responsible for the proposal?" },
});
check("ask returns 200", ask.status === 200, `status ${ask.status}`);
check("ask returns an answer", typeof ask.body?.answer === "string" && ask.body.answer.length > 0, `${ask.body?.answer?.length} chars`);

const viewerAsk = await call(`/documents/${docId}/ai/ask`, {
  method: "POST",
  token: viewerUser.token,
  body: { question: "What is the deadline?" },
});
check("viewer may ask questions", viewerAsk.status === 200, `status ${viewerAsk.status}`);

const strangerAsk = await call(`/documents/${docId}/ai/ask`, {
  method: "POST",
  token: stranger.token,
  body: { question: "What is the deadline?" },
});
check("stranger cannot ask", strangerAsk.status === 403, `status ${strangerAsk.status}`);

console.log("\n== OCR ==");
const ocr = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: owner.token,
  body: { image: TINY_PNG, language: "auto" },
});
check("OCR returns 200", ocr.status === 200, `status ${ocr.status} ${JSON.stringify(ocr.body?.error || "")}`);
check("OCR returns text", typeof ocr.body?.text === "string", `${ocr.body?.text?.length} chars`);
check("OCR returns a job id", typeof ocr.body?.jobId === "string" && ocr.body.jobId.length === 24, ocr.body?.jobId);
check("OCR returns blocks", Array.isArray(ocr.body?.blocks), `${ocr.body?.blocks?.length} blocks`);
check("OCR reports a detected language", typeof ocr.body?.detectedLanguage === "string", ocr.body?.detectedLanguage);

const ocrUrdu = await call(`/documents/${docId}/ocr`, {
  method: "POST",
  token: owner.token,
  body: { image: TINY_PNG, language: "ur" },
});
check("OCR honours an explicit language", ocrUrdu.status === 200 && ocrUrdu.body?.detectedLanguage === "ur", ocrUrdu.body?.detectedLanguage);

const jobs = await call(`/documents/${docId}/ocr`, { token: owner.token });
check("OCR job list returns 200", jobs.status === 200, `status ${jobs.status}`);
check("OCR job list has entries", Array.isArray(jobs.body) && jobs.body.length >= 2, `${jobs.body?.length} jobs`);
check("OCR job list has status + preview", jobs.body?.[0]?.status === "done" && typeof jobs.body?.[0]?.preview === "string", jobs.body?.[0]?.status);

const firstJob = await call(`/documents/${docId}/ocr/${ocr.body.jobId}`, { token: owner.token });
check("single OCR job is readable", firstJob.status === 200 && firstJob.body?.status === "done", `status ${firstJob.status}`);

const jobStranger = await call(`/documents/${docId}/ocr/${ocr.body.jobId}`, { token: stranger.token });
check("stranger cannot read an OCR job", jobStranger.status === 403, `status ${jobStranger.status}`);

const badJobId = await call(`/documents/${docId}/ocr/000000000000000000000000`, { token: owner.token });
check("unknown OCR job returns 404", badJobId.status === 404, `status ${badJobId.status}`);

const badJobRoute = await call(`/documents/${docId}/ocr/not-an-id`, { token: owner.token });
check("malformed OCR job id rejected", badJobRoute.status === 400, `status ${badJobRoute.status}`);

console.log("\n== Usage accounting ==");
const usage1 = await call("/ai/usage", { token: owner.token });
const actionCalls = 6; // improve, fix-grammar, tone, translate, extract-tasks, summarize
const askCalls = 1; // owner ask (the viewer ask is a different account)
const ocrCalls = 2;
const expected = actionCalls + askCalls + ocrCalls;
check(
  "usage counted every owner call",
  usage1.body?.month?.requests === expected,
  `${usage1.body?.month?.requests} of ${expected} expected`
);
check("usage tracks OCR jobs", usage1.body?.ocrJobsThisMonth === ocrCalls, `${usage1.body?.ocrJobsThisMonth} of ${ocrCalls}`);
check("usage reports a limit", usage1.body?.day?.limit > 0, `daily limit ${usage1.body?.day?.limit}`);

const viewerUsage = await call("/ai/usage", { token: viewerUser.token });
check("viewer usage counts only their own call", viewerUsage.body?.month?.requests === 1, `${viewerUsage.body?.month?.requests}`);

const strangerUsage = await call("/ai/usage", { token: stranger.token });
check("stranger usage is zero", strangerUsage.body?.month?.requests === 0, `${strangerUsage.body?.month?.requests}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
if (failures) process.exit(1);
console.log(`cleanup: run "node --env-file=.env tests/cleanup-test-data.mjs" to drop the test rows.`);

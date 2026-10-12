/**
 * Notification WebSocket test.
 *
 * The bell no longer polls every 30 seconds; it holds a per-user socket open and
 * refreshes when the server pushes an event. This covers that path:
 *  1. The short-lived socket token is issued only to an authenticated caller.
 *  2. A socket opened with a valid token receives a push when a notification is
 *     created for that user.
 *  3. A socket opened without a token is refused.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 WS_BASE=ws://localhost:5051/ws node tests/notifications-ws.test.mjs
 */
import WebSocket from "ws";

const API = process.env.API || "http://localhost:5051/api/v1";
const WS_BASE = process.env.WS_BASE || "ws://localhost:5051/ws";

let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -> ${detail}` : ""}`);
  if (!condition) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The hosted Mongo cluster drops idle connections; retry transient 500s. */
async function callRetry(path, options = {}, attempts = 4) {
  let res = await call(path, options);
  for (let i = 1; i < attempts && res.status === 500; i += 1) {
    await sleep(1200);
    res = await call(path, options);
  }
  return res;
}

const stamp = Date.now();
const ownerEmail = `wso${stamp}@example.com`;
const editorEmail = `wse${stamp}@example.com`;

async function register(name, email) {
  const res = await callRetry("/auth/register", {
    method: "POST",
    body: { name, email, password: "password123" },
  });
  if (res.status >= 400) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Open the notification channel and collect every frame it receives. */
function openNotifySocket(token) {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/notifications${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(url);
    const received = [];
    ws.on("message", (raw) => {
      try {
        received.push(JSON.parse(raw.toString()));
      } catch {
        // ignore non-JSON frames
      }
    });
    ws.on("open", () => resolve({ ws, received }));
    ws.on("error", reject);
  });
}

/** Resolve the close code of a socket that should be refused. */
function refusedCode(token) {
  return new Promise((resolve) => {
    const url = `${WS_BASE}/notifications${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => resolve(null), 10000);
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("error", () => {
      // The close event still follows; let it settle.
    });
  });
}

async function waitFor(received, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received.find(predicate);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

console.log("\n== Setup ==");
const owner = await register("Notify Owner", ownerEmail);
const editor = await register("Notify Editor", editorEmail);
check("owner ready", Boolean(owner.token), ownerEmail);
check("editor ready", Boolean(editor.token), editorEmail);

const created = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Notification WS Test" },
});
check("owner creates a document", created.status === 201, `status ${created.status}`);
const docId = created.body?._id;

await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: editorEmail, role: "editor" },
});

console.log("\n== Socket token ==");
const unauthed = await call("/auth/socket-token");
check("socket token requires auth", unauthed.status === 401, `status ${unauthed.status}`);

const tokenRes = await call("/auth/socket-token", { token: editor.token });
check(
  "socket token is issued",
  tokenRes.status === 200 && typeof tokenRes.body?.token === "string",
  `status ${tokenRes.status}`
);

console.log("\n== Push delivery ==");
const { ws, received } = await openNotifySocket(tokenRes.body.token);
check("socket opens with a token", ws.readyState === WebSocket.OPEN);
const ready = await waitFor(received, (m) => m.type === "ready", 10000);
check("server greets the socket", Boolean(ready));

// A mention creates a notification for the editor, which should be pushed.
await call(`/documents/${docId}/comments`, {
  method: "POST",
  token: owner.token,
  body: {
    body: `Please review @[Notify Editor](${editor.user.id})`,
    quotedText: "",
    from: 0,
    to: 0,
  },
});

const pushed = await waitFor(received, (m) => m.type === "notification");
check("editor receives a push", Boolean(pushed), pushed ? JSON.stringify(pushed) : "no push");
check("push names the notification type", pushed?.notificationType === "mention", pushed?.notificationType);

// The feed itself still works, so the bell can refresh on the push.
const feed = await call("/notifications", { token: editor.token });
check("feed reflects the mention", (feed.body?.items?.length || 0) >= 1, `${feed.body?.items?.length} items`);

ws.close();

console.log("\n== Refusal ==");
const code = await refusedCode("");
check("socket without a token is refused", code === 4401, `close code ${code}`);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nALL WS NOTIFICATION CHECKS PASSED");
process.exit(0);

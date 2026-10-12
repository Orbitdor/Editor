/**
 * WebSocket collaboration permission test.
 *
 * Covers what the HTTP test cannot, because the socket path has its own
 * authorization logic:
 *  1. A viewer cannot push CRDT updates even while the owner holds the room.
 *  2. A shared editor can.
 *  3. A revoked user is closed out by the periodic role re-check.
 *  4. A user with no access is refused at connect time.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 WS_BASE=ws://localhost:5051/ws node tests/collab-ws.test.mjs
 */
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";
import jwt from "jsonwebtoken";

const API = process.env.API || "http://localhost:5051/api/v1";
const WS_BASE = process.env.WS_BASE || "ws://localhost:5051/ws";

let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -> ${detail}` : ""}`);
  if (!condition) failures += 1;
};

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
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The hosted Mongo cluster drops idle connections, so a request can fail with a
 * transient server-selection error. Retry those instead of failing the run.
 */
async function callRetry(path, options = {}, attempts = 4) {
  let res = await call(path, options);
  for (let i = 1; i < attempts && res.status === 500; i += 1) {
    await sleep(1200);
    res = await call(path, options);
  }
  return res;
}

const stamp = Date.now();
const ownerEmail = `wson${stamp}@example.com`;
const viewerEmail = `wsv${stamp}@example.com`;

async function register(name, email) {
  const res = await callRetry("/auth/register", {
    method: "POST",
    body: { name, email, password: "password123" },
  });
  if (res.status >= 400) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Open a socket, complete the Yjs handshake and mirror every server update into
 * a local Y.Doc so assertions can read the real document text.
 *
 * `synced` resolves once the server has answered our sync step-1. Waiting for it
 * matters: until then the connection is not in the room's broadcast set yet, so
 * an update sent right after `open` can be missed.
 */
function openSocket(docId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?doc=${docId}&token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";

    const localDoc = new Y.Doc();
    let closeCode = null;
    let markSynced;
    const synced = new Promise((r) => {
      markSynced = r;
    });

    ws.on("message", (data) => {
      try {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const decoder = decoding.createDecoder(bytes);
        if (decoding.readVarUint(decoder) !== 0) return; // not a sync message

        const type = decoding.readVarUint(decoder);
        // Both step-2 and a plain update carry a varUint8Array CRDT payload.
        if (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate) {
          Y.applyUpdate(localDoc, decoding.readVarUint8Array(decoder));
          if (type === syncProtocol.messageYjsSyncStep2) markSynced();
        }
      } catch (err) {
        console.log(`  (decode ignored: ${err.message})`);
      }
    });

    ws.on("close", (code) => {
      closeCode = code;
      markSynced(); // never leave a waiter hanging on a rejected socket
    });

    const timer = setTimeout(() => reject(new Error("socket handshake timed out")), 8000);
    ws.on("open", () => {
      // Sync step 1 asks the server for its current state.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, localDoc);
      ws.send(encoding.toUint8Array(enc));
      clearTimeout(timer);
      resolve({ ws, doc: localDoc, synced, get closeCode() { return closeCode; } });
    });
  });
}

/** Push local CRDT state to the server, the way a ProseMirror change arrives. */
function pushState(ws, ydoc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(ydoc));
  ws.send(encoding.toUint8Array(enc));
}

console.log("\n== Setup ==");
const owner = await register("WS Owner", ownerEmail);
const viewer = await register("WS Viewer", viewerEmail);
const doc = await callRetry("/documents", { method: "POST", token: owner.token, body: { title: "WS Permission Test" } });
const docId = doc.body._id;
const shared = await callRetry(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: viewerEmail, role: "viewer" },
});
check("owner shared doc with viewer", shared.status === 200, `status ${shared.status}`);

console.log("\n== Viewer joins an owner-occupied room ==");
const ownerSock = await openSocket(docId, owner.token);
await ownerSock.synced;
check("owner socket opened and synced", ownerSock.ws.readyState === 1, "open");

const viewerSock = await openSocket(docId, viewer.token);
await viewerSock.synced;
check("viewer socket opened (no 4403)", viewerSock.ws.readyState === 1, "open");

// The owner writes real content.
ownerSock.doc.getText("body").insert(0, "owner content");
pushState(ownerSock.ws, ownerSock.doc);
await sleep(800);
check("owner content is on the room", viewerSock.doc.getText("body").toString().includes("owner content"), JSON.stringify(viewerSock.doc.getText("body").toString()));

console.log("\n== Viewer tries to write ==");
viewerSock.doc.getText("body").insert(0, "TAMPERED");
pushState(viewerSock.ws, viewerSock.doc);
await sleep(1000);

// A brand new client must see the authoritative, untampered state.
const freshSock = await openSocket(docId, owner.token);
await freshSock.synced;
const freshText = freshSock.doc.getText("body").toString();
check("viewer edit was rejected", !freshText.includes("TAMPERED"), JSON.stringify(freshText));
check("owner content survived", freshText.includes("owner content"), JSON.stringify(freshText));

console.log("\n== A shared editor may write ==");
const editorUser = await register("WS Editor", `wse${stamp}@example.com`);
await callRetry(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: `wse${stamp}@example.com`, role: "editor" },
});
const editorSock = await openSocket(docId, editorUser.token);
await editorSock.synced;
editorSock.doc.getText("body").insert(freshText.length, " + editor edit");
pushState(editorSock.ws, editorSock.doc);
await sleep(1000);
const afterEditor = await openSocket(docId, owner.token);
await afterEditor.synced;
check(
  "editor edit was accepted",
  afterEditor.doc.getText("body").toString().includes("+ editor edit"),
  JSON.stringify(afterEditor.doc.getText("body").toString())
);
editorSock.ws.close();
afterEditor.ws.close();
await sleep(200);

console.log("\n== Revocation on a live socket ==");
const revoke = await callRetry(`/documents/${docId}/share/${viewer.user.id}`, {
  method: "DELETE",
  token: owner.token,
});
check("access revoked over HTTP", revoke.status === 200, `status ${revoke.status}`);

// The re-check interval is 15s, so wait a little past it.
const closed = await Promise.race([
  new Promise((r) => {
    if (viewerSock.closeCode !== null) return r(viewerSock.closeCode);
    viewerSock.ws.on("close", () => r(viewerSock.closeCode));
  }),
  sleep(22000).then(() => "timeout"),
]);
check("revoked viewer socket was closed", closed === 4403, `close code ${closed}`);

console.log("\n== Unauthorized user is refused ==");
const stranger = await register("WS Stranger", `wss${stamp}@example.com`);
const strangerCode = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS_BASE}?doc=${docId}&token=${encodeURIComponent(stranger.token)}`);
  let code = "none";
  ws.on("close", (c) => {
    code = c;
  });
  setTimeout(() => resolve(code), 5000);
});
check("stranger socket closed with 4403", strangerCode === 4403, `close code ${strangerCode}`);

for (const s of [ownerSock, viewerSock, freshSock]) {
  try {
    s.ws.close();
  } catch {
    // already closed
  }
}
await sleep(300);

console.log(`\n${failures === 0 ? "ALL WS CHECKS PASSED" : `${failures} WS CHECK(S) FAILED`}\n`);
console.log(`cleanup: trash the WS test document ${docId} if needed.`);
process.exit(failures === 0 ? 0 : 1);


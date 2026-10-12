import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";
import jwt from "jsonwebtoken";
import Document from "../models/doc.model.js";
import { resolveRole, canAccess } from "../services/access.service.js";
import { ACCESS_COOKIE, readCookie } from "../services/token.service.js";

/** Document room: docId -> { ydoc, awareness, clients, role info }. */
const docs = new Map();
/** Debounced persist timers: docId -> timeout handle. */
const persistTimers = new Map();

/** Yjs sync protocol message type. */
const MSG_SYNC = 0;
/** Awareness (presence/cursor) message type. */
const MSG_AWARENESS = 1;
/** Query awareness state (client asks who is online). */
const MSG_QUERY_AWARENESS = 2;

/** Debounce before writing the CRDT snapshot to MongoDB. */
const PERSIST_DELAY = 1500;

/** How often a live socket re-resolves its role (picks up downgrades/revokes). */
const ROLE_RECHECK_MS = 15_000;

const SECRET = process.env.JWT_SECRET || "dev-secret";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function send(conn, encoder) {
  if (conn.readyState !== 1) return; // 1 === OPEN
  try {
    conn.send(encoding.toUint8Array(encoder));
  } catch (err) {
    console.error("[collab] send failed:", err?.message);
  }
}

/** Broadcast a Yjs update produced by one client to everyone else. */
function sendUpdateTo(conn, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  send(conn, encoder);
}

/** Broadcast presence state for the given client ids. */
function sendAwarenessTo(conn, changed) {
  if (!changed.length) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(conn.doc.awareness, changed)
  );
  send(conn, encoder);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Flush the in-memory CRDT state to MongoDB.
 *
 * The owner is not used as a filter any more: a shared editor may be the one
 * whose session produced the update, and they must still be able to persist it.
 */
async function persistNow(doc) {
  if (!doc.savePending) return;

  const buf = Y.encodeStateAsUpdate(doc.ydoc);
  try {
    await Document.updateOne({ _id: doc.docId }, { $set: { collabSync: Buffer.from(buf) } });
    doc.savePending = false;
  } catch (err) {
    console.error("[collab] persist failed:", err?.message);
  }
}

/** Coalesce rapid updates into one write. */
function schedulePersist(doc) {
  doc.savePending = true;
  clearTimeout(persistTimers.get(doc.docId));
  persistTimers.set(
    doc.docId,
    setTimeout(() => {
      persistTimers.delete(doc.docId);
      persistNow(doc);
    }, PERSIST_DELAY)
  );
}

// ---------------------------------------------------------------------------
// Document rooms
// ---------------------------------------------------------------------------

/**
 * Load (or reuse) the in-memory Yjs room for a document.
 *
 * This only deals with the room itself. Access control is per connection and
 * lives in `authorizeConnection`, because a single room is shared by an owner,
 * editors, commenters and viewers at the same time: the room must never carry
 * a "can write" flag of whoever connected first.
 *
 * @throws {Error} with `code` set to a WebSocket close code (4404/4410).
 */
async function getDoc(docId) {
  const cached = docs.get(docId);
  if (cached) return cached;

  const m = await Document.findById(docId).select("owner collabSync trashedAt").lean();
  if (!m) {
    const err = new Error("Document not found");
    err.code = 4404;
    throw err;
  }
  if (m.trashedAt) {
    const err = new Error("Document is in trash");
    err.code = 4410;
    throw err;
  }

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // Rehydrate the CRDT from the last snapshot so returning users see content.
  if (m.collabSync) {
    try {
      Y.applyUpdate(
        ydoc,
        new Uint8Array(m.collabSync.buffer, m.collabSync.byteOffset, m.collabSync.byteLength)
      );
    } catch (err) {
      console.error("[collab] failed to apply stored snapshot:", err?.message);
    }
  }

  const doc = {
    docId,
    owner: String(m.owner),
    ydoc,
    awareness,
    clients: new Set(),
    savePending: false,
  };
  // Fan every local update out to the other connected clients.
  ydoc.on("update", (update, origin) => {
    schedulePersist(doc);
    for (const client of doc.clients) {
      if (client !== origin) sendUpdateTo(client, update);
    }
  });

  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    if (!changed.length) return;
    for (const client of doc.clients) {
      if (client !== origin) sendAwarenessTo(client, changed);
    }
  });

  docs.set(docId, doc);
  return doc;
}

/**
 * Resolve what this specific user may do on the document.
 *
 * Called on every connection, never cached on the room, so joining an already
 * active room cannot bypass the access list.
 *
 * @throws {Error} with `code` 4403 when the user has no role.
 */
async function authorizeConnection(docId, userId) {
  const role = await resolveRole(docId, userId);
  if (!role) {
    const err = new Error("Access denied");
    err.code = 4403;
    throw err;
  }
  return role;
}

/** Tear down a room once the last client leaves, after a final flush. */
function closeDoc(docId) {
  const doc = docs.get(docId);
  if (!doc) return;
  if (doc.clients.size > 0) return;

  clearTimeout(persistTimers.get(docId));
  persistTimers.delete(docId);
  persistNow(doc);
  docs.delete(docId);
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

export async function setupWSConnection(conn, request) {
  const url = new URL(request.url, "http://localhost");

  // Document id comes from ?doc=... or from the /ws/<docId> path form.
  let docId = url.searchParams.get("doc");
  if (!docId && url.pathname.startsWith("/ws/")) {
    docId = decodeURIComponent(url.pathname.slice(4).replace(/[^a-zA-Z0-9]/g, ""));
  }
  // Prefer the HttpOnly session cookie so the token never has to appear in a
  // WebSocket URL (it would land in server logs and proxy access logs). The
  // `token` query param stays supported for non-browser clients and the suite.
  const cookieToken = readCookie(request, ACCESS_COOKIE);
  const token = url.searchParams.get("token") || cookieToken || "";

  // 1. Authenticate before touching any protocol state.
  let user;
  try {
    const payload = jwt.verify(token, SECRET);
    user = { id: payload.id, email: payload.email };
  } catch {
    conn.close(4401, "Unauthorized");
    return;
  }

  if (!docId) {
    conn.close(4400, "Missing document id");
    return;
  }

  conn.binaryType = "arraybuffer";

  // 2. Load the room asynchronously, but attach listeners synchronously so no
  //    message arriving during the database round-trip is lost. Messages are
  //    queued behind `docReady` and processed in order once the room exists.
  let resolveDoc;
  const docReady = new Promise((resolve) => {
    resolveDoc = resolve;
  });
  /** Interval handle for the periodic role re-check, cleared on close. */
  let recheckTimer;

  conn.on("message", (data) => {
    docReady.then((doc) => {
      if (!doc) return;
      handleMessage(conn, doc, data);
    });
  });

  conn.on("close", () => {
    clearInterval(recheckTimer);
    docReady.then((doc) => {
      if (!doc) return;
      doc.clients.delete(conn);
      // Drop this client's presence state so cursors disappear immediately.
      awarenessProtocol.removeAwarenessStates(doc.awareness, [conn], null);
      closeDoc(doc.docId);
    });
  });

  conn.on("error", (err) => {
    console.error("[collab] socket error:", err?.message);
  });

  try {
    const doc = await getDoc(docId);
    // Authorize this connection, not the room: it is re-checked for every
    // client so joining an active room still enforces the access list.
    const role = await authorizeConnection(docId, user.id);
    conn.doc = doc;
    conn.ydoc = doc.ydoc;
    conn.awareness = doc.awareness;
    conn.role = role;
    conn.canWrite = canAccess(role, "editor");
    doc.clients.add(conn);

    // Re-check periodically so a downgrade or revoke takes effect on a live
    // tab instead of only on reconnect. The share cache makes this cheap.
    recheckTimer = setInterval(async () => {
      if (conn.readyState !== 1) return;
      try {
        const current = await authorizeConnection(docId, user.id);
        conn.role = current;
        conn.canWrite = canAccess(current, "editor");
      } catch {
        conn.close(4403, "Access revoked");
      }
    }, ROLE_RECHECK_MS);
    recheckTimer.unref?.();

    resolveDoc(doc);
  } catch (err) {
    resolveDoc(null);
    conn.close(err.code || 4400, err.message);
  }
}

/**
 * Process one client message.
 *
 * `conn` is passed as the sync origin so the resulting Yjs update is not echoed
 * back to the client that sent it. Write permission is read from the connection
 * (never the room), so a viewer sharing a room with an owner is still rejected.
 *
 * Each sub-message type is answered only when it has an answer: sending a bare
 * `0` frame after a step-2 would leave the real client parsing an empty payload.
 */
function handleMessage(conn, doc, data) {
  const decoder = decoding.createDecoder(new Uint8Array(data));
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MSG_SYNC) {
    const inner = decoding.readVarUint(decoder);

    if (inner === syncProtocol.messageYjsSyncStep2) {
      // Carries the client's local edits, so it is the write path we guard.
      if (!conn.canWrite) return;
      syncProtocol.readSyncStep2(decoder, doc.ydoc, conn);
      return;
    }

    if (inner === syncProtocol.messageYjsUpdate) {
      // Follow-up updates from an already synced client.
      if (!conn.canWrite) return;
      syncProtocol.readUpdate(decoder, doc.ydoc, conn);
      return;
    }

    if (inner === syncProtocol.messageYjsSyncStep1) {
      // The client asked for our state: answer with a step-2, then presence.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep2(encoder, doc.ydoc);
      send(conn, encoder);

      const states = Array.from(doc.awareness.getStates().keys());
      if (states.length) sendAwarenessTo(conn, states);
      return;
    }

    // Unknown sub-type: ignore it rather than answering with a broken frame.
    return;
  }

  if (messageType === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      doc.awareness,
      decoding.readVarUint8Array(decoder),
      conn
    );
    return;
  }

  if (messageType === MSG_QUERY_AWARENESS) {
    const states = Array.from(doc.awareness.getStates().keys());
    if (states.length) sendAwarenessTo(conn, states);
  }
}

/**
 * Flush and drop a room. Called on server shutdown so nothing is lost.
 */
export async function shutdownCollab() {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  await Promise.all([...docs.values()].map((doc) => persistNow(doc)));
  docs.clear();
}

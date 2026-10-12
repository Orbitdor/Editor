import jwt from "jsonwebtoken";
import Notification from "../models/Notification.model.js";
import { ACCESS_COOKIE, readCookie } from "../services/token.service.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

/** How often an idle socket is pinged so a dead peer is noticed. */
const PING_MS = 30_000;

/**
 * How often a socket checks Mongo for a notification the push path could not
 * deliver.
 *
 * On a serverless host the request that creates a notification runs in a
 * different function instance than the socket, so in-process delivery cannot
 * reach it. This function owns its Mongo connection, so polling the feed is what
 * actually delivers the event there. On a single-process server it is a cheap
 * safety net behind the immediate in-process push.
 */
const DB_POLL_MS = 10_000;

/** userId -> Set<WebSocket>. One entry per tab the user has open. */
const clients = new Map();

/**
 * A per-user notification channel on the shared WebSocket server.
 *
 * This carries only a small "something changed" ping; the client still fetches
 * the feed over HTTP. That keeps the socket stateless about notification shape,
 * so changing the feed never touches the transport.
 *
 * Authenticated by the same HttpOnly session cookie as the REST API, so the
 * token never appears in a WebSocket URL.
 */
export function setupNotifyConnection(conn, request) {
  const url = new URL(request.url, "http://localhost");
  const cookieToken = readCookie(request, ACCESS_COOKIE);
  const token = url.searchParams.get("token") || cookieToken || "";

  let userId;
  try {
    const payload = jwt.verify(token, SECRET);
    userId = String(payload.id);
  } catch {
    conn.close(4401, "Unauthorized");
    return;
  }

  conn.userId = userId;
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(conn);

  const ping = setInterval(() => {
    if (conn.readyState === 1) {
      try {
        conn.ping();
      } catch {
        // ignore
      }
    }
  }, PING_MS);
  ping.unref?.();

  // Cross-instance delivery: watch the newest notification for this user and
  // push when it changes. `lastSeen` starts null so the first pass only records
  // the baseline; the client fetches on connect, so nothing is missed.
  let lastSeen = null;
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || conn.readyState !== 1) return;
    polling = true;
    try {
      const latest = await Notification.findOne({ user: userId })
        .sort("-createdAt")
        .select("_id")
        .lean();
      const id = latest?._id ? String(latest._id) : null;
      const changed = lastSeen !== null && id !== lastSeen;
      const alreadySent = conn.notifyResyncPending;
      conn.notifyResyncPending = false;
      lastSeen = id;
      if (changed && !alreadySent) {
        conn.send(JSON.stringify({ type: "notification" }));
      }
    } catch {
      // A transient DB error just means the next tick retries.
    } finally {
      polling = false;
    }
  }, DB_POLL_MS);
  poll.unref?.();

  conn.on("message", () => {
    // The channel is push-only; ignore anything the client sends.
  });

  conn.on("close", () => {
    clearInterval(ping);
    clearInterval(poll);
    const current = clients.get(userId);
    if (!current) return;
    current.delete(conn);
    if (!current.size) clients.delete(userId);
  });

  conn.on("error", () => {
    // A socket error is followed by close, which does the cleanup.
  });

  // Tell the client the channel is live, so it can stop relying on the fallback
  // poll immediately rather than waiting for the first notification.
  try {
    conn.send(JSON.stringify({ type: "ready" }));
  } catch {
    // ignore
  }
}

/**
 * Push an event to every open tab of the given users.
 *
 * Best-effort by design: notifications are a convenience, and a user with no
 * open socket is simply served by their next HTTP fetch.
 *
 * @param {string[]} userIds
 * @param {{type: string, [key: string]: any}} message
 */
export function publishToUsers(userIds, message) {
  const payload = JSON.stringify(message);
  for (const userId of new Set((userIds || []).map(String))) {
    const set = clients.get(userId);
    if (!set) continue;
    for (const conn of set) {
      if (conn.readyState !== 1) continue;
      try {
        // Mark it so the DB poll does not push the same change again.
        conn.notifyResyncPending = true;
        conn.send(payload);
      } catch {
        // ignore
      }
    }
  }
}

/** Current number of live notification sockets, for diagnostics. */
export function notifyConnectionCount() {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return total;
}

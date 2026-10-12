import { NOTIFY_WS_BASE } from "./ws-base.js";
import { getSocketToken } from "./api.js";

/**
 * Is a realtime notification transport configured in this build?
 *
 * False when no socket host is set, in which case the bell falls back to polling.
 */
export const NOTIFICATIONS_REALTIME = Boolean(NOTIFY_WS_BASE);

/**
 * Subscribe to the per-user notification channel.
 *
 * The server pushes a small event whenever something new lands for the signed-in
 * user, so the badge updates without a poll.
 *
 * The socket may live on a different origin than the one holding the session
 * cookie, so a short-lived token is fetched first (over the same-origin API) and
 * passed in the query string. The token is refreshed on every reconnect.
 *
 * Returns an unsubscribe function. Reconnects with capped backoff, and is a no-op
 * when no realtime transport is configured.
 *
 * @param {(event: {type: string}) => void} onEvent
 * @returns {() => void}
 */
export function subscribeNotifications(onEvent) {
  if (typeof window === "undefined" || !NOTIFY_WS_BASE) return () => {};

  let socket = null;
  let retryTimer = null;
  let retries = 0;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    retries += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retries, 5));
    retryTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (stopped) return;

    let token = "";
    try {
      const data = await getSocketToken();
      token = data?.token || "";
    } catch {
      // Not signed in, or offline: try again later rather than looping hot.
      schedule();
      return;
    }
    if (stopped) return;

    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${NOTIFY_WS_BASE}${query}`;

    try {
      socket = new WebSocket(url);
    } catch {
      schedule();
      return;
    }

    socket.onopen = () => {
      retries = 0;
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // "ready" is delivered on every (re)connect. Forwarding it makes the bell
        // resync once after a drop, so an event missed while offline is not lost.
        if (message?.type) onEvent(message);
      } catch {
        // A malformed frame should never break the bell.
      }
    };
    socket.onclose = () => {
      if (!stopped) schedule();
    };
    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        // ignore
      }
    };
  }

  connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    try {
      socket?.close();
    } catch {
      // ignore
    }
  };
}

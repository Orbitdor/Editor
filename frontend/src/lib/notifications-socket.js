import { WS_BASE } from "./ws-base.js";

/**
 * Is a realtime transport available at all in this build?
 *
 * False on a serverless deployment with no `NEXT_PUBLIC_WS_URL`, where callers
 * must fall back to HTTP polling.
 */
export const NOTIFICATIONS_REALTIME = Boolean(WS_BASE);

/**
 * Subscribe to the per-user notification channel.
 *
 * The server pushes a small event whenever something new lands for the signed-in
 * user, so the badge updates without a poll. The socket is authenticated by the
 * same HttpOnly session cookie as the REST API, so no token is put in the URL.
 *
 * Returns an unsubscribe function. It reconnects with capped backoff, and is a
 * no-op when there is no realtime transport.
 *
 * @param {(event: {type: string}) => void} onEvent
 * @returns {() => void}
 */
export function subscribeNotifications(onEvent) {
  if (typeof window === "undefined" || !WS_BASE) return () => {};

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

  function connect() {
    if (stopped) return;
    try {
      socket = new WebSocket(`${WS_BASE}/notifications`);
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
        if (message?.type && message.type !== "ready") onEvent(message);
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

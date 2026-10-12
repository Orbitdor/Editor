// Realtime transport base, shared by the editor's collaboration socket and the
// notification socket.
//
// A long-lived WebSocket needs a host that can upgrade a connection. Local dev
// talks to the API on :5000. In production, set NEXT_PUBLIC_WS_URL to a host that
// can upgrade connections, or leave it empty and callers fall back to HTTP.
export const WS_BASE = (
  process.env.NEXT_PUBLIC_WS_URL ||
  (process.env.NODE_ENV === "production" ? "" : "ws://localhost:5000/ws")
).replace(/\/$/, "");

// The notification channel may use a different realtime host than collaboration.
// On a serverless deployment only notifications are enabled over a socket (so the
// bell stops polling); realtime document collaboration still needs a host that can
// keep a shared Yjs room, so it stays on `WS_BASE`.
export const NOTIFY_WS_BASE = (
  process.env.NEXT_PUBLIC_NOTIFY_WS_URL ||
  WS_BASE ||
  ""
).replace(/\/$/, "");

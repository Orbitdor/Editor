// Realtime transport base, shared by the editor's collaboration socket and the
// notification socket.
//
// A long-lived WebSocket needs a host that can upgrade a connection. A
// serverless platform (Vercel functions) cannot, so in production with no
// explicit NEXT_PUBLIC_WS_URL there is no realtime transport at all: callers
// fall back to HTTP. Local dev keeps talking to the API on :5000.
export const WS_BASE = (
  process.env.NEXT_PUBLIC_WS_URL ||
  (process.env.NODE_ENV === "production" ? "" : "ws://localhost:5000/ws")
).replace(/\/$/, "");

import http from "http";
import { WebSocketServer } from "ws";
import { setupNotifyConnection } from "../websocket/notify.server.js";
import { connectDB } from "../config/db.js";

// Connect eagerly so the first socket is not delayed, but never block: the
// handshake only needs JWT_SECRET, and Mongo is only read by the REST feed.
connectDB();

// A dedicated function file (Vercel serves `api/ws.js` at `/api/ws`) is the
// documented way to host WebSockets: the default export must be an `http.Server`
// so the platform can perform the upgrade. The REST API lives in a separate
// bundle, so this channel is deliberately self-contained.
//
// Plain HTTP requests here mean a client forgot to upgrade.
const server = http.createServer((_req, res) => {
  res.statusCode = 426;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Upgrade required" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    setupNotifyConnection(ws, request);
  });
});

export default server;

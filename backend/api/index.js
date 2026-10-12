import "dotenv/config";
import http from "http";
import app, { connectDB } from "../app.js";
import { startWebsocket } from "../websocket/index.js";

// Connect eagerly so the first request does not pay for it, but never block
// startup on it: the API answers with a clear 503 until Mongo is reachable.
connectDB();

// Vercel can host WebSocket connections when the function's default export is a
// `http.Server` rather than a bare request handler. Exporting the server (instead
// of `app`) is what lets the collaboration and notification channels upgrade on
// the same origin as the REST API. Locally the same wiring runs in `index.js`.
const server = http.createServer(app);
startWebsocket(server);

export default server;

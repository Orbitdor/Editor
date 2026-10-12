import { WebSocketServer } from "ws";
import { setupWSConnection } from "./collab.server.js";
import { setupNotifyConnection } from "./notify.server.js";

export function startWebsocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    // A serverless host serves the function under `/api`, so a socket arrives as
    // `/api/ws/...`; running locally it arrives as `/ws/...`. Strip the prefix so
    // both forms route identically (the handlers parse the path themselves).
    if (request.url?.startsWith("/api/ws")) {
      request.url = request.url.slice(4);
    }

    const path = request.url?.split("?")[0] || "";

    // The notification channel is per user, not per document, so it is routed
    // before the document handler (which would read the path as a document id).
    if (path === "/ws/notifications") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        setupNotifyConnection(ws, request);
      });
      return;
    }

    if (path.startsWith("/ws")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        setupWSConnection(ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  return wss;
}

import { WebSocketServer } from "ws";
import { setupWSConnection } from "./collab.server.js";

export function startWebsocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?")[0].startsWith("/ws")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        setupWSConnection(ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  return wss;
}
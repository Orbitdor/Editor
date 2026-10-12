import http from "http";
import app, { connectDB } from "./app.js";
import { startWebsocket } from "./websocket/index.js";
import { ensureBuiltIns } from "./services/template.service.js";

const server = http.createServer(app);
startWebsocket(server);

connectDB()
  .then(async (ok) => {
    // The built-in template library (master plan section 32) lives in code, so a
    // fresh install and an upgrade both need it written before anyone browses.
    // A failure here must not stop the API: browsing falls back to writing them on
    // demand, and the rest of the app does not depend on templates.
    if (ok) {
      try {
        await ensureBuiltIns();
        console.log("Built-in templates ready");
      } catch (err) {
        console.error("Could not seed built-in templates:", err.message);
      }
    }
  })
  .finally(() => {
    server.listen(process.env.PORT || 5000, () => {
      console.log(`API running on port ${process.env.PORT || 5000}`);
    });
  });
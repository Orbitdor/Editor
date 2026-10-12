import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import v1Router from "./routes/v1/index.js";
import { connectDB, getDBError } from "./config/db.js";
import { notFound, errorHandler, securityHeaders } from "./middleware/error.middleware.js";

const app = express();

app.set("trust proxy", 1);
// Signed attachment links are verified by a controller, which has no module-level
// access to the secret. Exposing it on app.locals keeps one source of truth
// without threading it through every route signature.
app.locals.jwtSecret = process.env.JWT_SECRET || "dev-secret";
app.use(securityHeaders);

/**
 * Cookies require an explicit origin: `cors()` alone reflects nothing, so the
 * browser would drop the HttpOnly session cookie on every call. The allow-list
 * comes from FRONTEND_URL so a cookie is never issued to an unknown origin.
 */
const ALLOWED_ORIGINS = (
  process.env.FRONTEND_URL ||
  process.env.GOOGLE_FRONTEND_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers (curl, the test suite) send no Origin.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);

/**
 * Upload routes carry base64 payloads in the JSON body, so they need more room
 * than an ordinary API call: an audio clip can be 15 MB before it is encoded,
 * which becomes ~20 MB of base64. The parser is registered on those paths only
 * and before the default, so every other endpoint keeps the small limit.
 */
const uploadJson = express.json({ limit: "25mb" });
app.use("/api/v1/documents/:id/voice/transcribe", uploadJson);
app.use("/api/v1/documents/:id/ocr", uploadJson);

app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "Doc Editor API", version: "v1" });
});

app.get("/api/health", async (_req, res) => {
  const ok = await connectDB();
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "error",
    connected: ok,
    readyState: mongoose.connection.readyState,
    mongoUriSet: !!process.env.MONGO_URI,
    detail: ok ? null : getDBError(),
  });
});

app.use("/api/v1", v1Router);

app.use(notFound);
app.use(errorHandler);

export { connectDB };
export default app;
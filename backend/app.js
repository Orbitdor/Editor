import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import v1Router from "./routes/v1/index.js";
import { connectDB, getDBError } from "./config/db.js";
import { notFound, errorHandler, securityHeaders } from "./middleware/error.middleware.js";

const app = express();

app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(cors());
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
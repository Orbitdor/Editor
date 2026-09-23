import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import docRoutes from "./routes/doc.routes.js";
import { connectDB, getDBError } from "./config/db.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "Doc Editor API" });
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

app.use("/api/documents", async (req, res, next) => {
  const ok = await connectDB();
  if (!ok) {
    return res.status(503).json({
      error: "Database not connected",
      detail: getDBError(),
    });
  }
  next();
});

app.use("/api/documents", docRoutes);

export { connectDB };
export default app;
import { Router } from "express";
import { connectDB, getDBError } from "../../config/db.js";
import authRouter from "./auth.route.js";
import documentRouter from "./document.route.js";

const v1 = Router();

v1.use(async (req, res, next) => {
  const ok = await connectDB();
  if (!ok) {
    return res.status(503).json({ error: "Database not connected", detail: getDBError() });
  }
  next();
});

v1.use("/auth", authRouter);
v1.use("/documents", documentRouter);

v1.get("/health", (_req, res) => res.json({ status: "ok", version: "v1" }));

export default v1;
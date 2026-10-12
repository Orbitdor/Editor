import { Router } from "express";
import { connectDB, getDBError } from "../../config/db.js";
import authRouter, { googleAuthRouter } from "./auth.route.js";
import documentRouter from "./document.route.js";
import collaborationRouter from "./collaboration.route.js";
import notificationRouter from "./notification.route.js";
import shareRouter from "./share.route.js";
import publicRouter from "./public.route.js";
import aiRouter, { globalAiRouter } from "./ai.route.js";
import ocrRouter from "./ocr.route.js";
import voiceRouter, { globalVoiceRouter } from "./voice.route.js";
import googleRouter from "./google.route.js";
import workspaceRouter from "./workspace.route.js";
import folderRouter from "./folder.route.js";
import templateRouter from "./template.route.js";
import attachmentRouter, { uploadRouter } from "./attachment.route.js";

const v1 = Router();

// Every API call waits for MongoDB, so a cold start cannot produce a confusing
// "document not found" cascade before the connection is established.
v1.use(async (req, res, next) => {
  const ok = await connectDB();
  if (!ok) {
    return res.status(503).json({ error: "Database not connected", detail: getDBError() });
  }
  next();
});

v1.use("/auth", authRouter);
// Sign-in has no session yet, so it is a sibling of /auth rather than a child.
v1.use("/auth/google", googleAuthRouter);
v1.use("/documents", documentRouter);
v1.use("/documents", collaborationRouter);
v1.use("/notifications", notificationRouter);
// The public link routes are mounted first on the same prefix: `/shared/:token` has
// to reach the unauthenticated router before `shareRouter`'s requireAuth turns it
// into a 401. `/shared` on its own still falls through to the authenticated list.
v1.use("/shared", publicRouter);
v1.use("/shared", shareRouter);
// AI, OCR and voice are document-scoped, so they hang off the document router.
v1.use("/documents/:id/ai", aiRouter);
v1.use("/documents", ocrRouter);
v1.use("/documents/:id/voice", voiceRouter);
v1.use("/ai", globalAiRouter);
// Voice capability is global: the microphone button probes it before a
// document is even open.
v1.use("/voice", globalVoiceRouter);
// The Google Integration Center, kept under one namespace so connecting Drive,
// Docs, Speech or Vision is one discoverable place (master plan section 29).
v1.use("/integrations/google", googleRouter);
// Workspaces, membership, plans and the audit log (master plan sections 36, 46, 49).
v1.use("/workspaces", workspaceRouter);
// Folders give the library its tree (master plan section 11).
v1.use("/folders", folderRouter);
// Built-in, workspace and AI-generated templates (master plan sections 32 and 33).
v1.use("/templates", templateRouter);
// File attachments and object storage (master plan sections 27 and 45). The
// uploads alias exists because section 38 names that path.
v1.use("/attachments", attachmentRouter);
v1.use("/uploads", uploadRouter);

v1.get("/health", (_req, res) => res.json({ status: "ok", version: "v1" }));

export default v1;
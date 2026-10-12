import * as aiService from "../services/ai.service.js";
import * as ocrService from "../services/ocr.service.js";
import * as usageService from "../services/usage.service.js";
import { authorize, getWorkspace } from "../services/workspace.service.js";
import { providerStatus } from "../config/ai.js";

/**
 * AI writing assistant
 */

// GET /api/v1/ai/status -> provider capability, used to enable/disable the UI
export const getStatus = (_req, res) => {
  res.json(providerStatus());
};

// GET /api/v1/ai/usage -> quota snapshot for the signed-in user
export const getUsage = async (req, res) => {
  // `?workspaceId` reports the quota of a team the caller belongs to, so the AI
  // panel can show the plan the team is on rather than the personal default.
  const workspaceId = req.query.workspaceId || null;
  if (workspaceId) {
    // A workspace's quota is only visible to its members.
    await authorize(workspaceId, req.user.id, "viewer");
  }
  const workspace = workspaceId ? await getWorkspace(workspaceId) : null;
  res.json(await usageService.usageSummary(req.user.id, workspace));
};

// POST /api/v1/ai/:id/action -> run a writing action (improve, summarize, ...)
export const runAction = async (req, res) => {
  const { action, text, tone, language, selection } = req.body || {};
  res.json(
    await aiService.runAction(req.params.id, req.user.id, { action, text, tone, language, selection })
  );
};

// POST /api/v1/ai/:id/ask -> ask a question about the document
export const ask = async (req, res) => {
  const { question, language } = req.body || {};
  res.json(await aiService.askAboutDocument(req.params.id, req.user.id, { question, language }));
};

/**
 * OCR
 */

// POST /api/v1/ocr/:id -> extract text from a base64 image
export const runOcr = async (req, res) => {
const { image, language, provider } = req.body || {};
    res.json(await ocrService.runOcr(req.params.id, req.user.id, { image, language, provider }));
};

// GET /api/v1/ocr/:id -> recent OCR jobs
export const listJobs = async (req, res) => {
  res.json(await ocrService.listJobs(req.params.id, req.user.id, req.query.limit));
};

// GET /api/v1/ocr/:id/:jobId -> one OCR job
export const getJob = async (req, res) => {
  res.json(await ocrService.getJob(req.params.id, req.params.jobId, req.user.id));
};

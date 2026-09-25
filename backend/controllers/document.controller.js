import * as documentService from "../services/document.service.js";
import { listVersions, restoreVersion as restoreDocVersionService } from "../services/version.service.js";
import { buildExport } from "../services/export.service.js";
import { ApiError } from "../utils/ApiError.js";

export const getDocs = async (req, res) => {
  const { scope, q, tags } = req.query;
  const tagList = typeof tags === "string" && tags ? tags.split(",") : [];
  res.json(await documentService.listDocuments(req.user.id, { scope, q, tags: tagList }));
};

export const createDoc = async (req, res) => {
  const doc = await documentService.createDocument(req.user.id, req.body);
  res.status(201).json(doc);
};

export const getDoc = async (req, res) => {
  res.json(await documentService.getDocument(req.params.id, req.user.id));
};

export const saveDoc = async (req, res) => {
  res.json(await documentService.updateDocument(req.params.id, req.user.id, req.body));
};

export const trashDoc = async (req, res) => {
  res.json(await documentService.trashDocument(req.params.id, req.user.id));
};

export const restoreDoc = async (req, res) => {
  res.json(await documentService.restoreDocument(req.params.id, req.user.id));
};

export const starDoc = async (req, res) => {
  res.json(await documentService.starDocument(req.params.id, req.user.id, req.body.starred));
};

export const tagDoc = async (req, res) => {
  res.json(await documentService.setTags(req.params.id, req.user.id, req.body.tags));
};

export const getVersions = async (req, res) => {
  res.json(await listVersions(req.params.id, req.user.id));
};

export const restoreDocVersion = async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(400, "Invalid version");
  }
  res.json(await restoreDocVersionService(req.params.id, req.user.id, version));
};

export const exportDoc = async (req, res) => {
  const doc = await documentService.getDocument(req.params.id, req.user.id);
  const format = ["markdown", "txt", "html"].includes(req.query.format)
    ? req.query.format
    : "html";
  const { content, ext, type } = buildExport(doc, format);
  res
    .status(200)
    .set("Content-Type", type)
    .set(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.title || "document")}.${ext}"`
    )
    .send(content);
};
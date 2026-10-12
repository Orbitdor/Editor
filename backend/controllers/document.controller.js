import * as documentService from "../services/document.service.js";
import { listVersions, restoreVersion } from "../services/version.service.js";
import { buildExport, buildBinaryExport } from "../services/export.service.js";
import Attachment from "../models/Attachment.model.js";

/** Valid export formats, with their file extension. */
const EXPORT_FORMATS = { markdown: "md", html: "html", txt: "txt", pdf: "pdf", docx: "docx" };

/**
 * Documents
 */

// GET /api/v1/documents?scope=all|starred|trash&q=&tags=&workspaceId=&folderId=&unfiled=
export const getDocs = async (req, res) => {
  const { scope, q, tags, workspaceId, folderId, unfiled } = req.query;
  const tagList = typeof tags === "string" && tags ? tags.split(",") : [];
  res.json(
    await documentService.listDocuments(req.user.id, {
      scope,
      q,
      tags: tagList,
      workspaceId: workspaceId || null,
      folderId: folderId || null,
      unfiled: unfiled === "true" || unfiled === "1",
    })
  );
};

// POST /api/v1/documents
export const createDoc = async (req, res) => {
  const doc = await documentService.createDocument(req.user.id, req.body);
  res.status(201).json(doc);
};

// GET /api/v1/documents/:id
export const getDoc = async (req, res) => {
  res.json(await documentService.getDocument(req.params.id, req.user.id));
};

// PUT /api/v1/documents/:id  -> autosave
export const saveDoc = async (req, res) => {
  res.json(await documentService.updateDocument(req.params.id, req.user.id, req.body));
};

// POST /api/v1/documents/:id/trash
export const trashDoc = async (req, res) => {
  res.json(await documentService.trashDocument(req.params.id, req.user.id));
};

// POST /api/v1/documents/:id/restore
export const restoreDoc = async (req, res) => {
  res.json(await documentService.restoreDocument(req.params.id, req.user.id));
};

// DELETE /api/v1/documents/:id - permanent, from the trash only
export const deleteDoc = async (req, res) => {
  res.json(await documentService.deleteDocument(req.params.id, req.user.id));
};

// PATCH /api/v1/documents/:id/star
export const starDoc = async (req, res) => {
  res.json(await documentService.starDocument(req.params.id, req.user.id, req.body.starred));
};

// PUT /api/v1/documents/:id/tags
export const tagDoc = async (req, res) => {
  res.json(await documentService.setTags(req.params.id, req.user.id, req.body.tags));
};

/**
 * Versions
 */

// GET /api/v1/documents/:id/versions
export const getVersions = async (req, res) => {
  res.json(await listVersions(req.params.id, req.user.id));
};

// POST /api/v1/documents/:id/versions/:version/restore
export const restoreDocVersion = async (req, res) => {
  res.json(await restoreVersion(req.params.id, req.user.id, Number(req.params.version)));
};

/**
 * Export
 */

// GET /api/v1/documents/:id/export?format=markdown|html|txt|pdf|docx
export const exportDoc = async (req, res) => {
  const requested = EXPORT_FORMATS[req.query.format] ? req.query.format : "html";
  // Any viewer may export; the service enforces access.
  const doc = await documentService.getDocument(req.params.id, req.user.id);

  // PDF and DOCX are rendered from the document's own blocks and may embed stored
  // images, so the attachment lookup is handed in rather than imported here.
  const binary = requested === "pdf" || requested === "docx";
  const { content, ext, type } = binary
    ? await buildBinaryExport(doc, requested, {
        resolveStorageKey: async (attachmentId) => {
          const row = await Attachment.findById(attachmentId).select("storageKey").lean();
          return row?.storageKey || null;
        },
      })
    : buildExport(doc, requested);

  res
    .status(200)
    .set("Content-Type", type)
    .set(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.title || "document")}.${ext}"`
    )
    .send(content);
};

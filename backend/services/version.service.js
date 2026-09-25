import DocumentVersion from "../models/DocumentVersion.model.js";
import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";

const MAX_VERSIONS_PER_DOC = 50;

export async function snapshotDocument(doc, userId) {
  await DocumentVersion.create({
    document: doc._id,
    version: doc.version,
    title: doc.title,
    content: doc.content,
    contentJson: doc.contentJson,
    plainText: doc.plainText,
    savedBy: userId,
  });

  const count = await DocumentVersion.countDocuments({ document: doc._id });
  if (count > MAX_VERSIONS_PER_DOC) {
    const toDelete = await DocumentVersion.find({ document: doc._id })
      .sort({ version: 1 })
      .limit(count - MAX_VERSIONS_PER_DOC)
      .select("_id");
    await DocumentVersion.deleteMany({
      _id: { $in: toDelete.map((v) => v._id) },
    });
  }
}

export async function listVersions(documentId, userId) {
  const doc = await Document.findById(documentId);
  if (!doc) throw new ApiError(404, "Document not found");
  if (!doc.owns(userId)) throw new ApiError(403, "Access denied");
  return DocumentVersion.find({ document: documentId })
    .sort("-version")
    .select("version title plainText savedBy updatedAt");
}

export async function restoreVersion(documentId, userId, version) {
  const doc = await Document.findById(documentId);
  if (!doc) throw new ApiError(404, "Document not found");
  if (!doc.owns(userId)) throw new ApiError(403, "Access denied");

  const v = await DocumentVersion.findOne({ document: documentId, version });
  if (!v) throw new ApiError(404, "Version not found");

  await snapshotDocument(doc, userId);
  doc.title = v.title || doc.title;
  doc.content = v.content || "";
  doc.contentJson = v.contentJson;
  doc.version += 1;
  await doc.save();
  return doc;
}
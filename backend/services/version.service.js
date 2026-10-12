import DocumentVersion from "../models/DocumentVersion.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorize, authorizeEdit } from "./access.service.js";

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

/**
 * Version history. Viewers and commenters can read history (useful for
 * context), but only editors can restore a version.
 */
export async function listVersions(documentId, userId) {
  await authorize(documentId, userId, "viewer");
  return DocumentVersion.find({ document: documentId })
    .sort("-version")
    .select("version title plainText savedBy updatedAt");
}

export async function restoreVersion(documentId, userId, version) {
  const { doc } = await authorizeEdit(documentId, userId);

  const v = await DocumentVersion.findOne({ document: documentId, version });
  if (!v) throw new ApiError(404, "Version not found");

  // Keep the current state in history before rolling back.
  await snapshotDocument(doc, userId);
  doc.title = v.title || doc.title;
  doc.content = v.content || "";
  doc.contentJson = v.contentJson;
  doc.version += 1;
  await doc.save();
  return doc;
}
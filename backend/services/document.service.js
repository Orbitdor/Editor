import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";
import { snapshotDocument } from "./version.service.js";

async function findOwned(id, userId) {
  const doc = await Document.findById(id);
  if (!doc) throw new ApiError(404, "Document not found");
  if (!doc.owns(userId)) throw new ApiError(403, "Access denied");
  return doc;
}

export async function listDocuments(userId, { scope = "all", q = "", tags = [] } = {}) {
  const filter = { owner: userId };

  if (scope === "trash") filter.trashedAt = { $ne: null };
  else if (scope === "starred") {
    filter.trashedAt = null;
    filter.starred = true;
  } else {
    filter.trashedAt = null;
  }

  if (tags.length) filter.tags = { $all: tags };

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { plainText: rx }];
  }

  return Document.find(filter).sort("-updatedAt").limit(200);
}

export async function getDocument(id, userId) {
  const doc = await findOwned(id, userId);
  if (!doc.trashedAt) {
    doc.lastOpenedAt = new Date();
    await doc.save({ validateModifiedOnly: true });
  }
  return doc;
}

export async function createDocument(userId, { title } = {}) {
  const placeholders = await Document.find({
    owner: userId,
    title: /^Untitled\d*$/,
  })
    .select("title")
    .lean();

  let max = -1;
  for (const d of placeholders) {
    const m = /^Untitled(\d*)$/.exec(d.title);
    const n = m ? (m[1] === "" ? 0 : parseInt(m[1], 10)) : -1;
    if (n > max) max = n;
  }
  const name = title?.trim() || (max === -1 ? "Untitled" : `Untitled${max + 1}`);

  return Document.create({ title: name, content: "", owner: userId });
}

export async function updateDocument(id, userId, patch) {
  const doc = await findOwned(id, userId);

  const contentChanged = hasOwn(patch, "content") && patch.content !== doc.content;
  const jsonChanged =
    hasOwn(patch, "contentJson") &&
    JSON.stringify(patch.contentJson ?? null) !== JSON.stringify(doc.contentJson ?? null);
  const titleChanged = hasOwn(patch, "title") && patch.title !== doc.title;
  const changed = contentChanged || jsonChanged || titleChanged;

  if (changed) {
    await snapshotDocument(doc, userId);
    if (hasOwn(patch, "title")) doc.title = String(patch.title).slice(0, 200) || doc.title;
    if (hasOwn(patch, "content")) doc.content = String(patch.content);
    if (hasOwn(patch, "contentJson")) doc.contentJson = patch.contentJson ?? null;
    if (contentChanged || jsonChanged) doc.version += 1;
  }

  await doc.save();
  return doc;
}

export async function trashDocument(id, userId) {
  const doc = await findOwned(id, userId);
  if (!doc.trashedAt) {
    doc.trashedAt = new Date();
    await doc.save({ validateModifiedOnly: true });
  }
  return doc;
}

export async function restoreDocument(id, userId) {
  const doc = await findOwned(id, userId);
  if (doc.trashedAt) {
    doc.trashedAt = null;
    await doc.save({ validateModifiedOnly: true });
  }
  return doc;
}

export async function starDocument(id, userId, starred) {
  const doc = await findOwned(id, userId);
  doc.starred = Boolean(starred);
  await doc.save({ validateModifiedOnly: true });
  return doc;
}

export async function setTags(id, userId, tags) {
  const doc = await findOwned(id, userId);
  doc.tags = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  await doc.save({ validateModifiedOnly: true });
  return doc;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
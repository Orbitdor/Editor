import Document from "../models/doc.model.js";
import Folder from "../models/Folder.model.js";
import { ApiError } from "../utils/ApiError.js";
import { snapshotDocument } from "./version.service.js";
import {
  authorize,
  authorizeEdit,
  authorizeOwner,
  canAccess,
  resolveRole,
} from "./access.service.js";
import Share from "../models/Share.model.js";
import { authorize as authorizeWorkspace, memberRole, refreshStats, resolveWorkspace } from "./workspace.service.js";
import { roleAtLeast } from "../models/WorkspaceMember.model.js";
import * as audit from "./audit.service.js";
import { describeLimitBreach, planFor } from "../config/plans.js";
import { purgeDocument as purgeAttachments } from "./attachment.service.js";
import { cacheConfig } from "../config/cache.js";
import { cacheDel, cacheDelPrefix, cacheKey, getOrSet } from "./cache.service.js";

/**
 * Drop every cached view of a document after a write.
 *
 * Two families of key are affected:
 *   - `doc:body:<id>`  the single-document read used when opening the editor;
 *   - `docs:...`       the dashboard lists.
 *
 * Lists are namespaced by workspace when one is given (every member of a
 * workspace sees the same list, so one entry serves them all) and by user for
 * the personal view. Clearing by prefix reaches every scope, folder, tag and
 * search variant in one go, which is why the variants are stored under a common
 * prefix rather than as flat keys.
 *
 * @param {{docId?: string|null, workspaceId?: string|null, ownerIds?: string[]}} params
 */
function invalidateDocumentCaches({ docId = null, workspaceId = null, ownerIds = [] } = {}) {
  const jobs = [];
  if (docId) jobs.push(cacheDel(cacheKey("doc:body", docId)));
  if (workspaceId) jobs.push(cacheDelPrefix(`${cacheKey("docs", "ws", workspaceId)}:`));
  for (const id of new Set(ownerIds.map(String))) {
    jobs.push(cacheDelPrefix(`${cacheKey("docs", "user", id)}:`));
  }
  return Promise.all(jobs);
}

/**
 * List the caller's own documents.
 *
 * @param {string} userId
 * @param {{scope?: "all"|"starred"|"trash", q?: string, tags?: string[], workspaceId?: string, folderId?: string, unfiled?: boolean}} options
 */
export async function listDocuments(
  userId,
  { scope = "all", q = "", tags = [], workspaceId = null, folderId = null, unfiled = false } = {}
) {
  // Without a workspace this lists the caller's own documents, which is what the
  // personal dashboard has always shown. Resolving a workspace also authorises
  // the caller, and that check deliberately stays *outside* the cached loader:
  // a removed member must be refused even when a warm cache still has the list.
  const filter = workspaceId ? await workspaceFilter(userId, workspaceId) : { owner: userId };

  if (scope === "trash") filter.trashedAt = { $ne: null };
  else if (scope === "starred") {
    filter.trashedAt = null;
    filter.starred = true;
  } else {
    filter.trashedAt = null;
  }

  // Folder drill-down. `unfiled` is the "My documents" root, which means no
  // folder at all, so it has to be asked for explicitly rather than inferred
  // from an absent folderId.
  if (folderId) filter.folder = folderId;
  else if (unfiled) filter.folder = null;

  if (tags.length) filter.tags = { $all: tags };

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { plainText: rx }];
  }

  // A workspace list is identical for every member, so it is cached once under
  // the workspace; the personal list is cached under the user.
  const key = workspaceId
    ? cacheKey("docs", "ws", workspaceId, scope, folderId, unfiled, [...tags].sort().join(","), q)
    : cacheKey("docs", "user", userId, scope, folderId, unfiled, [...tags].sort().join(","), q);

  return getOrSet(key, cacheConfig().ttl.documents, async () =>
    Document.find(filter)
      // `contentJson` and `collabSync` are the two heaviest fields and the
      // dashboard never renders them; `linkShare.token` is the public-link
      // credential the model would normally strip, so it is excluded here too
      // because a lean query bypasses that transform.
      .select("-contentJson -collabSync -linkShare")
      .sort("-updatedAt")
      .limit(200)
      .lean()
  );
}

/**
 * Turn a workspace id into a document filter, after checking the caller belongs
 * to it. A non-member gets a 404 rather than an empty list, so they cannot use
 * this endpoint to discover which workspaces exist.
 */
async function workspaceFilter(userId, workspaceId) {
  await authorizeWorkspace(workspaceId, userId, "viewer");
  return { workspace: workspaceId };
}

/**
 * Fetch a document the caller can at least view.
 *
 * The response carries `access` so the client knows whether to allow editing,
 * commenting or sharing without a second round-trip.
 *
 * The body is read through the cache: content is identical for everyone who can
 * see it, so it is stored once per document and the per-user `access` block is
 * layered on top after the role is resolved.
 */
export async function getDocument(id, userId) {
  const { doc, role } = await authorize(id, userId, "viewer", { fromCache: true });

  if (!doc.trashedAt) touchLastOpened(id, doc.lastOpenedAt);

  const plain = { ...doc };
  plain.access = {
    role,
    canEdit: canAccess(role, "editor"),
    canComment: canAccess(role, "commenter"),
    canShare: role === "owner",
  };
  return plain;
}

/**
 * Note that the document was opened, without making the caller wait for it.
 *
 * This used to be an awaited `doc.save()` on every single GET, so opening a
 * document always cost a MongoDB write on top of the read -- for a timestamp
 * nobody waits for. It is fire-and-forget now, and only written when the stored
 * value is more than a minute old, so a reload pays nothing for it.
 */
function touchLastOpened(id, lastOpenedAt) {
  const last = lastOpenedAt ? new Date(lastOpenedAt).getTime() : 0;
  if (Date.now() - last < 60_000) return;
  Document.updateOne({ _id: id }, { $set: { lastOpenedAt: new Date() } }).catch(() => null);
}

export async function createDocument(userId, { title, workspaceId, folderId = null } = {}) {
  // Every document belongs to a workspace. Resolving it here means the call site
  // does not have to know workspaces exist, and a document can never end up
  // without an owner space.
  const workspace = await resolveWorkspace(userId, workspaceId);

  // Creating in someone else's workspace is a membership question, not a document
  // one, so it is settled before anything is written.
  if (String(workspace.owner) !== String(userId)) {
    const role = await memberRole(workspace._id, userId);
    if (!roleAtLeast(role, "editor")) {
      throw new ApiError(403, "You need the editor role in that workspace to add documents");
    }
  }

  // A document filed into a folder must land in that folder's own workspace,
  // otherwise one workspace's library would gain another workspace's document.
  if (folderId) {
    const folder = await Folder.findById(folderId).lean();
    if (!folder || folder.trashedAt) throw new ApiError(404, "Folder not found");
    if (String(folder.workspace) !== String(workspace._id)) {
      throw new ApiError(400, "That folder belongs to a different workspace");
    }
  }

  const plan = planFor(workspace.plan);
  const held = await Document.countDocuments({ workspace: workspace._id, trashedAt: null });
  if (held >= plan.maxDocuments) {
    throw new ApiError(409, describeLimitBreach(workspace.plan, { documents: held }));
  }

  // Continue the "Untitled", "Untitled1", ... numbering per user.
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

  const doc = await Document.create({
    title: name,
    content: "",
    owner: userId,
    workspace: workspace._id,
    folder: folderId || null,
  });

  await refreshStats(workspace._id);
  await recordDoc(workspace._id, userId, "document.created", doc, { workspace: workspace.name });
  // The new document belongs in every list of that workspace, including the
  // personal one, so drop both families before the caller is handed back.
  await invalidateDocumentCaches({ workspaceId: workspace._id, ownerIds: [userId] });
  return doc;
}

/**
 * Append to the workspace audit log, if the document still has a workspace.
 *
 * A document created before workspaces existed has none, and there is nowhere to
 * write in that case, so the entry is skipped rather than faked.
 */
async function recordDoc(workspaceId, userId, action, doc, meta) {
  if (!workspaceId) return;
  await audit.record(workspaceId, {
    action,
    actor: { id: userId },
    resource: { type: "document", id: doc._id, name: doc.title },
    meta,
  });
}

/**
 * Persist content. Needs editor access, so shared editors can autosave too.
 */
export async function updateDocument(id, userId, patch) {
  const { doc } = await authorizeEdit(id, userId);

  const contentChanged = hasOwn(patch, "content") && patch.content !== doc.content;
  const jsonChanged =
    hasOwn(patch, "contentJson") &&
    JSON.stringify(patch.contentJson ?? null) !== JSON.stringify(doc.contentJson ?? null);
  const titleChanged = hasOwn(patch, "title") && patch.title !== doc.title;
  const changed = contentChanged || jsonChanged || titleChanged;

  if (changed) {
    // Snapshot before overwriting so history keeps the previous state.
    await snapshotDocument(doc, userId);
    if (hasOwn(patch, "title")) doc.title = String(patch.title).slice(0, 200) || doc.title;
    if (hasOwn(patch, "content")) doc.content = String(patch.content);
    if (hasOwn(patch, "contentJson")) doc.contentJson = patch.contentJson ?? null;
    if (contentChanged || jsonChanged) doc.version += 1;
  }

  await doc.save();

  if (changed) {
    // Autosave fires constantly, so only the parts a human would recognise as a
    // change are worth an audit line.
    await recordDoc(doc.workspace, userId, "document.updated", doc, {
      title: titleChanged || undefined,
      content: contentChanged || jsonChanged || undefined,
    });
    // The editor and both people's dashboards have to see the new content. An
    // editor who is not the owner has their own list key, so both ids are
    // cleared rather than assuming the writer owns the document.
    await invalidateDocumentCaches({
      docId: doc._id,
      workspaceId: doc.workspace,
      ownerIds: [doc.owner, userId],
    });
  }
  return doc;
}

export async function trashDocument(id, userId) {
  const doc = await authorizeOwner(id, userId);
  if (!doc.trashedAt) {
    doc.trashedAt = new Date();
    await doc.save({ validateModifiedOnly: true });
    await recordDoc(doc.workspace, userId, "document.trashed", doc);
    await invalidateDocumentCaches({
      docId: doc._id,
      workspaceId: doc.workspace,
      ownerIds: [doc.owner, userId],
    });
  }
  return doc;
}

export async function restoreDocument(id, userId) {
  const doc = await authorizeOwner(id, userId);
  if (doc.trashedAt) {
    doc.trashedAt = null;
    await doc.save({ validateModifiedOnly: true });
    await recordDoc(doc.workspace, userId, "document.restored", doc);
    await invalidateDocumentCaches({
      docId: doc._id,
      workspaceId: doc.workspace,
      ownerIds: [doc.owner, userId],
    });
  }
  return doc;
}

/**
 * Permanent delete. Owner only, and only from the trash: a document can still be
 * recovered until someone deliberately destroys it.
 *
 * The attachments go first. Their bytes live in object storage, so removing the
 * metadata rows without calling `purgeDocument` would leave the files on disk
 * forever with nothing pointing at them.
 */
export async function deleteDocument(id, userId) {
  const doc = await authorizeOwner(id, userId);
  if (!doc.trashedAt) {
    throw new ApiError(409, "Move the document to trash before deleting it");
  }

  const workspace = doc.workspace;
  const attachments = await purgeAttachments(id);
  await purgeDocumentShares(id);
  await Document.deleteOne({ _id: id });

  // Count the deletion, then fix the cached workspace totals it invalidated.
  await recordDoc(workspace, userId, "document.deleted", { _id: id, title: doc.title });
  await refreshStats(workspace).catch(() => null);
  await invalidateDocumentCaches({ docId: id, workspaceId: workspace, ownerIds: [doc.owner, userId] });
  return { ok: true, attachments: attachments.removed };
}

export async function starDocument(id, userId, starred) {
  const doc = await authorizeOwner(id, userId);
  doc.starred = Boolean(starred);
  await doc.save({ validateModifiedOnly: true });
  await invalidateDocumentCaches({
    docId: doc._id,
    workspaceId: doc.workspace,
    ownerIds: [doc.owner, userId],
  });
  return doc;
}

export async function setTags(id, userId, tags) {
  const doc = await authorizeOwner(id, userId);
  doc.tags = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  await doc.save({ validateModifiedOnly: true });
  await invalidateDocumentCaches({
    docId: doc._id,
    workspaceId: doc.workspace,
    ownerIds: [doc.owner, userId],
  });
  return doc;
}

/**
 * Read the stored Yjs snapshot for the WebSocket layer.
 * Anyone with viewer access may read; only editors may write (see below).
 */
export async function getCollabSnapshot(id, userId) {
  const role = await resolveRole(id, userId);
  if (!role) throw new ApiError(403, "Access denied");

  const doc = await Document.findById(id).select("collabSync").lean();
  if (!doc) throw new ApiError(404, "Document not found");
  return doc.collabSync ?? null;
}

/**
 * Write the Yjs snapshot. Only editors may persist document content.
 */
export async function saveCollabSnapshot(id, userId, snapshot) {
  const role = await resolveRole(id, userId);
  if (!canAccess(role, "editor")) {
    throw new ApiError(403, "Read-only access");
  }

  return Document.updateOne(
    { _id: id },
    { $set: { collabSync: Buffer.isBuffer(snapshot) ? snapshot : Buffer.from(snapshot) } }
  );
}

/** Remove every share entry of a document (hard delete cleanup). */
export async function purgeDocumentShares(docId) {
  await Share.deleteMany({ document: docId });
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

import mongoose from "mongoose";
import Folder from "../models/Folder.model.js";
import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";
import { roleAtLeast } from "../models/WorkspaceMember.model.js";
import { memberRole, refreshStats, resolveWorkspace } from "./workspace.service.js";
import { authorizeEdit } from "./access.service.js";
import * as audit from "./audit.service.js";

/**
 * Folders (master plan section 11).
 *
 * Permissions deliberately reuse the workspace role ladder the rest of the app
 * already uses rather than inventing a folder-specific one:
 *   - creating, renaming, nesting or trashing a folder needs `editor`, matching
 *     the bar for adding a document, because a folder is part of organising the
 *     library;
 *   - deleting one permanently needs `admin`, because that is the operation that
 *     changes what other people see.
 *
 * A personal workspace has exactly one member (its owner), who passes both.
 */

/** Resolve the workspace and assert the caller meets `minimum`. */
async function authorizeFolderSpace(userId, workspaceId, minimum) {
  const workspace = await resolveWorkspace(userId, workspaceId);

  // Non-members get a 404 rather than a 403, matching the workspace endpoints:
  // otherwise this route would confirm that a workspace exists to someone who
  // cannot see it.
  const role =
    String(workspace.owner) === String(userId) ? "owner" : await memberRole(workspace._id, userId);
  if (!role) throw new ApiError(404, "Workspace not found");
  if (!roleAtLeast(role, minimum)) {
    throw new ApiError(403, `You need the ${minimum} role in this workspace to manage its folders`);
  }
  return workspace;
}

/**
 * Live folders in one workspace, ordered as the sidebar shows them: top level
 * first, then each folder's children.
 */
export async function listFolders(userId, { workspaceId = null } = {}) {
  const workspace = await authorizeFolderSpace(userId, workspaceId, "viewer");
  const folders = await Folder.find({ workspace: workspace._id, trashedAt: null })
    .sort({ order: 1, name: 1 })
    .lean();

  const byId = new Map(folders.map((f) => [String(f._id), { ...f, children: [] }]));
  const roots = [];
  for (const folder of byId.values()) {
    const parent = folder.parent ? byId.get(String(folder.parent)) : null;
    // A folder whose parent was trashed or filtered out is promoted to the top
    // level rather than disappearing from the tree.
    if (parent) parent.children.push(folder);
    else roots.push(folder);
  }
  return roots;
}

export async function listTrashedFolders(userId, { workspaceId = null } = {}) {
  const workspace = await authorizeFolderSpace(userId, workspaceId, "viewer");
  return Folder.find({ workspace: workspace._id, trashedAt: { $ne: null } })
    .sort("-trashedAt")
    .lean();
}

/** Turn a duplicate-key error into the same 409 the limit checks raise. */
function rethrowDuplicate(err, name) {
  if (err?.code === 11000) {
    throw new ApiError(409, `A folder called "${name}" already exists here`);
  }
  throw err;
}

/** Reject a name that differs only by case from an existing sibling. */
async function assertNameFree({ workspace, parent, name, excludeId = null }) {
  const clash = await Folder.findOne({
    workspace: workspace._id,
    parent: parent || null,
    trashedAt: null,
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();
  if (clash) throw new ApiError(409, `A folder called "${name}" already exists here`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function createFolder(userId, { name, workspaceId = null, parent = null, color = null } = {}) {
  const workspace = await authorizeFolderSpace(userId, workspaceId, "editor");
  const clean = String(name || "").trim();
  if (!clean) throw new ApiError(400, "Folder name is required");

  if (parent) await assertParentOk(parent, workspace._id);

  await assertNameFree({ workspace, parent, name: clean });

  const last = await Folder.findOne({ workspace: workspace._id, parent: parent || null })
    .sort("-order")
    .select("order")
    .lean();

  let folder;
  try {
    folder = await Folder.create({
      name: clean,
      workspace: workspace._id,
      owner: userId,
      parent: parent || null,
      color,
      order: (last?.order ?? -1) + 1,
    });
  } catch (err) {
    // Two people can create "Work" at the same instant; the index settles it.
    rethrowDuplicate(err, clean);
  }

  await refreshStats(workspace._id);
  await audit.record(workspace._id, {
    action: "folder.created",
    actor: { id: userId },
    resource: { type: "folder", id: folder._id, name: folder.name },
  });
  return folder;
}

/** The parent must be live and in the same workspace. */
async function assertParentOk(parentId, workspaceId) {
  if (!mongoose.isValidObjectId(parentId)) throw new ApiError(400, "Parent folder is not valid");
  const parent = await Folder.findById(parentId).lean();
  if (!parent || parent.trashedAt) throw new ApiError(404, "Parent folder not found");
  if (String(parent.workspace) !== String(workspaceId)) {
    throw new ApiError(400, "Parent folder is in a different workspace");
  }
  return parent;
}

export async function updateFolder(userId, folderId, patch = {}) {
  const folder = await loadForWrite(userId, folderId, "editor");

  if (patch.name !== undefined) {
    const clean = String(patch.name).trim();
    if (!clean) throw new ApiError(400, "Folder name is required");
    await assertNameFree({
      workspace: { _id: folder.workspace },
      parent: folder.parent,
      name: clean,
      excludeId: folder._id,
    });
    folder.name = clean;
  }

  if (patch.parent !== undefined) {
    if (patch.parent) {
      await assertParentOk(patch.parent, folder.workspace);
      // A folder cannot be moved inside itself, directly or further down its own
      // branch, or the tree would grow a cycle and vanish from every listing.
      if (String(patch.parent) === String(folder._id)) {
        throw new ApiError(400, "A folder cannot be its own parent");
      }
      if (await isDescendant(patch.parent, folder._id)) {
        throw new ApiError(400, "A folder cannot be moved into one of its own subfolders");
      }
    }
    folder.parent = patch.parent || null;
  }

  if (patch.color !== undefined) folder.color = patch.color || null;
  if (patch.order !== undefined) folder.order = Number(patch.order) || 0;

  try {
    await folder.save();
  } catch (err) {
    rethrowDuplicate(err, folder.name);
  }

  await audit.record(folder.workspace, {
    action: "folder.updated",
    actor: { id: userId },
    resource: { type: "folder", id: folder._id, name: folder.name },
    meta: { name: patch.name !== undefined, moved: patch.parent !== undefined },
  });
  return folder;
}

/** Walk up from `candidateId` looking for `ancestorId`. */
async function isDescendant(candidateId, ancestorId) {
  let cursor = candidateId;
  for (let depth = 0; depth < 50; depth += 1) {
    if (String(cursor) === String(ancestorId)) return true;
    const row = await Folder.findById(cursor).select("parent").lean();
    if (!row?.parent) return false;
    cursor = row.parent;
  }
  // A cycle already in the data would spin forever; treat it as forbidden.
  return true;
}

async function loadForWrite(userId, folderId, minimum) {
  const folder = await Folder.findById(folderId);
  if (!folder || folder.trashedAt) throw new ApiError(404, "Folder not found");
  await authorizeFolderSpace(userId, folder.workspace, minimum);
  return folder;
}

/** Soft delete. Documents inside are kept and simply become unfiled. */
export async function trashFolder(userId, folderId) {
  const folder = await loadForWrite(userId, folderId, "editor");

  const children = await Folder.find({ parent: folder._id, trashedAt: null }).select("_id").lean();
  await Folder.updateMany(
    { _id: { $in: children.map((c) => c._id) } },
    { $set: { trashedAt: new Date() } }
  );
  // Documents survive: they are somebody's work, and unfiling them is recoverable
  // by restoring the folder.
  await Document.updateMany(
    { folder: folder._id, trashedAt: null },
    { $set: { folder: null } }
  );

  folder.trashedAt = new Date();
  await folder.save({ validateModifiedOnly: true });

  await refreshStats(folder.workspace);
  await audit.record(folder.workspace, {
    action: "folder.trashed",
    actor: { id: userId },
    resource: { type: "folder", id: folder._id, name: folder.name },
    meta: { children: children.length },
  });
  return folder;
}

export async function restoreFolder(userId, folderId) {
  const folder = await Folder.findById(folderId);
  if (!folder) throw new ApiError(404, "Folder not found");
  await authorizeFolderSpace(userId, folder.workspace, "editor");
  if (!folder.trashedAt) return folder;
  folder.trashedAt = null;
  await folder.save({ validateModifiedOnly: true });
  return folder;
}

/** Permanent delete, and the one folder operation that needs `admin`. */
export async function deleteFolder(userId, folderId) {
  const folder = await Folder.findById(folderId);
  if (!folder) throw new ApiError(404, "Folder not found");
  await authorizeFolderSpace(userId, folder.workspace, "admin");

  await Document.updateMany({ folder: folder._id }, { $set: { folder: null } });
  await Folder.deleteMany({ parent: folder._id });
  await folder.deleteOne();

  await refreshStats(folder.workspace);
  await audit.record(folder.workspace, {
    action: "folder.deleted",
    actor: { id: userId },
    resource: { type: "folder", id: folder._id, name: folder.name },
  });
  return { deleted: true };
}

/** Move a document into a folder, or out of one with `folderId: null`. */
export async function moveDocument(userId, docId, folderId) {
  const doc = await Document.findById(docId);
  if (!doc || doc.trashedAt) throw new ApiError(404, "Document not found");

  // The document decides the bar: moving it is an edit to the document.
  await authorizeEdit(docId, userId);

  if (folderId) {
    await assertParentOk(folderId, doc.workspace);
  }

  doc.folder = folderId || null;
  await doc.save({ validateModifiedOnly: true });

  await audit.record(doc.workspace, {
    action: "document.moved",
    actor: { id: userId },
    resource: { type: "document", id: doc._id, name: doc.title },
    meta: { folder: folderId || null },
  });
  return doc;
}

/** Everything in one folder, for the sidebar drill-down. */
export async function folderContents(userId, folderId, { workspaceId = null } = {}) {
  const workspace = await authorizeFolderSpace(userId, workspaceId, "viewer");
  const folder = await Folder.findOne({ _id: folderId, workspace: workspace._id, trashedAt: null }).lean();
  if (!folder) throw new ApiError(404, "Folder not found");

  const docs = await Document.find({ folder: folder._id, trashedAt: null })
    .sort("-updatedAt")
    .lean();
  return { folder, documents: docs };
}

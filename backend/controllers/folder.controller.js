import * as folders from "../services/folder.service.js";

/**
 * Folder HTTP layer (master plan section 11).
 *
 * Thin on purpose: the service decides permissions, and the router has already
 * validated the shape of every field by the time a controller runs.
 */

/** Shape one folder for the response, including its child count. */
function describe(folder) {
  if (!folder) return null;
  const plain = folder.toObject ? folder.toObject() : folder;
  return {
    _id: plain._id,
    name: plain.name,
    workspace: plain.workspace,
    parent: plain.parent ?? null,
    color: plain.color ?? null,
    order: plain.order ?? 0,
    trashedAt: plain.trashedAt ?? null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    ...(plain.children ? { children: plain.children.map(describe) } : {}),
    ...(plain.documents ? { documents: plain.documents } : {}),
  };
}

export const ListFolders = async (req, res) => {
  const tree = await folders.listFolders(req.user.id, { workspaceId: req.query.workspaceId || null });
  res.json({ folders: tree.map(describe) });
};

export const ListTrashedFolders = async (req, res) => {
  const rows = await folders.listTrashedFolders(req.user.id, {
    workspaceId: req.query.workspaceId || null,
  });
  res.json({ folders: rows.map(describe) });
};

export const CreateFolder = async (req, res) => {
  const folder = await folders.createFolder(req.user.id, req.body || {});
  res.status(201).json({ folder: describe(folder) });
};

export const UpdateFolder = async (req, res) => {
  const folder = await folders.updateFolder(req.user.id, req.params.id, req.body || {});
  res.json({ folder: describe(folder) });
};

export const TrashFolder = async (req, res) => {
  const folder = await folders.trashFolder(req.user.id, req.params.id);
  res.json({ folder: describe(folder) });
};

export const RestoreFolder = async (req, res) => {
  const folder = await folders.restoreFolder(req.user.id, req.params.id);
  res.json({ folder: describe(folder) });
};

export const DeleteFolder = async (req, res) => {
  res.json(await folders.deleteFolder(req.user.id, req.params.id));
};

export const FolderContents = async (req, res) => {
  const result = await folders.folderContents(req.user.id, req.params.id, {
    workspaceId: req.query.workspaceId || null,
  });
  res.json({ folder: describe(result.folder), documents: result.documents });
};

/** File a document into a folder, or unfile it with `folderId: null`. */
export const MoveDocument = async (req, res) => {
  const doc = await folders.moveDocument(req.user.id, req.params.id, req.body?.folderId ?? null);
  res.json({ document: { _id: doc._id, folder: doc.folder ?? null } });
};
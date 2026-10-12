import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { validateSchema, required, isString, isId, maxLen } from "../../middleware/validate.middleware.js";
import {
  CreateFolder,
  DeleteFolder,
  FolderContents,
  ListFolders,
  ListTrashedFolders,
  MoveDocument,
  RestoreFolder,
  TrashFolder,
  UpdateFolder,
} from "../../controllers/folder.controller.js";

/**
 * Folders (master plan section 11, and the `/api/v1/folders` route in section 38).
 *
 * Every route needs a session. Optional ids are validated only when present, and
 * `null` is allowed everywhere it means "top level" or "unfiled", so the
 * validators skip it and the service decides what it means.
 */
const r = Router();
r.use(requireAuth);

const idParam = { id: [isId()] };
const nameRules = [required("is required"), isString(), maxLen(120, "is too long")];

r.get("/", validateSchema({ workspaceId: [isId()] }, "query"), ListFolders);
r.get("/trash", validateSchema({ workspaceId: [isId()] }, "query"), ListTrashedFolders);

r.post(
  "/",
  validateSchema(
    {
      name: nameRules,
      workspaceId: [isId()],
      parent: [isId()],
      color: [isString(), maxLen(9, "is not a colour")],
    },
    "body"
  ),
  CreateFolder
);

// Filing a document is a document operation, so it is addressed by document id.
// It has to be declared before `/:id` or Express would treat "documents" as a
// folder id and answer 400 instead of moving anything.
r.put("/documents/:id", validateSchema(idParam, "params"), MoveDocument);

r.get(
  "/:id/contents",
  validateSchema(idParam, "params"),
  validateSchema({ workspaceId: [isId()] }, "query"),
  FolderContents
);
r.patch(
  "/:id",
  validateSchema(idParam, "params"),
  // Every field here is optional: a PATCH that only moves a folder must not be
  // forced to send a name, and the service treats an absent key as "leave alone".
  validateSchema(
    {
      name: [isString(), maxLen(120, "is too long")],
      parent: [isId()],
      color: [isString(), maxLen(9, "is not a colour")],
    },
    "body"
  ),
  UpdateFolder
);

// Soft delete by default, so a mistaken delete is recoverable from the sidebar's
// trash; the permanent one is explicit.
r.delete("/:id", validateSchema(idParam, "params"), TrashFolder);
r.post("/:id/restore", validateSchema(idParam, "params"), RestoreFolder);
r.delete("/:id/permanent", validateSchema(idParam, "params"), DeleteFolder);

export default r;
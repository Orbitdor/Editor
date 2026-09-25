import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, required, isString, isBoolean, isArrayOfStrings, isIn, maxLen, isId } from "../../middleware/validate.middleware.js";
import {
  getDocs,
  createDoc,
  getDoc,
  saveDoc,
  trashDoc,
  restoreDoc,
  starDoc,
  tagDoc,
  getVersions,
  restoreDocVersion,
  exportDoc,
} from "../../controllers/document.controller.js";

const r = Router();

r.use(requireAuth);
r.use(rateLimit({ windowMs: 60_000, max: 300, keyFor: (req) => `doc:${req.user.id}` }));

r.get(
  "/",
  validateSchema(
    {
      scope: [isIn(["all", "starred", "trash"], "must be one of all|starred|trash")],
      q: [isString(), maxLen(200, "too long")],
      tags: [isString(), maxLen(500, "too long")],
    },
    "query"
  ),
  getDocs
);
r.post("/", validateSchema({ title: [isString(), maxLen(200, "too long")] }), createDoc);

r.get("/:id/export", validateSchema({ id: [isId()] }, "params"), exportDoc);

r.get("/:id/versions", validateSchema({ id: [isId()] }, "params"), getVersions);
r.post(
  "/:id/versions/:version/restore",
  validateSchema(
    { id: [isId()], version: [isString()] },
    "params"
  ),
  restoreDocVersion
);

r.post("/:id/trash", validateSchema({ id: [isId()] }, "params"), trashDoc);
r.post("/:id/restore", validateSchema({ id: [isId()] }, "params"), restoreDoc);
r.patch(
  "/:id/star",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({ starred: [required("is required"), isBoolean()] }),
  starDoc
);
r.put(
  "/:id/tags",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({ tags: [required("is required"), isArrayOfStrings()] }),
  tagDoc
);

r.get("/:id", validateSchema({ id: [isId()] }, "params"), getDoc);
r.put(
  "/:id",
  validateSchema({ id: [isId()] }, "params"),
  validateSchema({
    title: [isString(), maxLen(200, "too long")],
    content: [isString()],
  }),
  saveDoc
);

export default r;
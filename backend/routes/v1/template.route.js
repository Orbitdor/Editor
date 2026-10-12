import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  validateSchema,
  required,
  isString,
  isId,
  isBoolean,
  isArrayOfStrings,
  isIn,
  maxLen,
} from "../../middleware/validate.middleware.js";
import { TEMPLATE_CATEGORIES, FIELD_TYPES } from "../../models/Template.model.js";
import {
  ListTemplates,
  ListSmartPrompts,
  GetTemplate,
  UseTemplate,
  SaveFromDocument,
  CreateTemplate,
  UpdateTemplate,
  DeleteTemplate,
  GenerateTemplate,
} from "../../controllers/template.controller.js";

/**
 * Templates (master plan sections 32 and 33, and the `/api/v1/templates` route in
 * section 38).
 *
 * Browsing needs a session but no workspace, because the built-in library belongs
 * to nobody and is visible to any signed-in user. Team templates appear alongside
 * it when the caller passes a workspace, or with their active workspace by default.
 *
 * `values` on the use route is a free-form map of field name to value, so it is not
 * shape-validated here; the service empties or substitutes each key it recognises
 * and leaves anything else in the body untouched.
 */
const r = Router();
r.use(requireAuth);

const idParam = { id: [isId()] };
const titleRules = [required("is required"), isString(), maxLen(160, "is too long")];
const categoryRules = [isIn(TEMPLATE_CATEGORIES, "is not a known category")];

// Browsing and the one-off AI prompts.
r.get(
  "/",
  validateSchema(
    { workspaceId: [isId()], category: categoryRules, q: [isString(), maxLen(120, "is too long")] },
    "query"
  ),
  ListTemplates
);
r.get("/smart/prompts", ListSmartPrompts);

// A document becomes a template. Declared before `/:id` so the literal path cannot
// be read as a template id.
r.post(
  "/from-document",
  validateSchema(
    {
      documentId: [required("is required"), isId()],
      title: [isString(), maxLen(160, "is too long")],
      description: [isString(), maxLen(400, "is too long")],
      category: categoryRules,
      tags: [isArrayOfStrings()],
    },
    "body"
  ),
  SaveFromDocument
);

// AI generation. Also before `/:id`, and it creates rather than edits.
r.post(
  "/generate",
  validateSchema(
    {
      prompt: [isString(), maxLen(2000, "is too long")],
      title: [isString(), maxLen(160, "is too long")],
      category: [isString(), maxLen(60, "is too long")],
      description: [isString(), maxLen(400, "is too long")],
      save: [isBoolean()],
      workspaceId: [isId()],
    },
    "body"
  ),
  GenerateTemplate
);

r.post(
  "/",
  validateSchema(
    {
      title: titleRules,
      content: [isString()],
      description: [isString(), maxLen(400, "is too long")],
      category: categoryRules,
      icon: [isString(), maxLen(8, "is too long")],
      tags: [isArrayOfStrings()],
      workspaceId: [isId()],
      fields: [
        (v) => (v === undefined ? undefined : Array.isArray(v) ? undefined : "must be an array"),
        (v) =>
          v === undefined
            ? undefined
            : v.every((f) => f && typeof f === "object" && FIELD_TYPES.includes(f.type || "text"))
              ? undefined
              : `each field needs a type of ${FIELD_TYPES.join(", ")}`,
      ],
    },
    "body"
  ),
  CreateTemplate
);

// One template, with its body.
r.get("/:id", validateSchema(idParam, "params"), GetTemplate);

// Turn a template into a document.
r.post(
  "/:id/use",
  validateSchema(
    {
      ...idParam,
      title: [isString(), maxLen(160, "is too long")],
      workspaceId: [isId()],
      folderId: [isId()],
      values: [
        (v) =>
          v === undefined
            ? undefined
            : v && typeof v === "object" && !Array.isArray(v)
              ? undefined
              : "must be an object of field name to value",
      ],
    },
    "body"
  ),
  UseTemplate
);

r.patch(
  "/:id",
  validateSchema(
    {
      ...idParam,
      title: [isString(), maxLen(160, "is too long")],
      description: [isString(), maxLen(400, "is too long")],
      category: categoryRules,
      icon: [isString(), maxLen(8, "is too long")],
      tags: [isArrayOfStrings()],
      fields: [
        (v) => (v === undefined ? undefined : Array.isArray(v) ? undefined : "must be an array"),
        (v) =>
          v === undefined
            ? undefined
            : v.every((f) => f && typeof f === "object" && FIELD_TYPES.includes(f.type || "text"))
              ? undefined
              : `each field needs a type of ${FIELD_TYPES.join(", ")}`,
      ],
    },
    "body"
  ),
  UpdateTemplate
);

r.delete(
  "/:id",
  validateSchema({ ...idParam, workspaceId: [isId()] }, "query"),
  DeleteTemplate
);

export default r;

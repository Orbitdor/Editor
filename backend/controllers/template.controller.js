import * as templates from "../services/template.service.js";
import { ApiError } from "../utils/ApiError.js";
import { SMART_TEMPLATE_PROMPTS, SMART_CATEGORIES } from "../config/templates.js";

/**
 * Template HTTP layer (master plan sections 32 and 33).
 *
 * Thin on purpose, like the other controllers: the service decides permissions and
 * the router has already validated the shape of every field.
 */

/** A plain object from a query string is an error, not an empty values map. */
function valuesOf(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "values must be an object of field name to value");
  }
  return raw;
}

/** The built-in library plus the caller's workspace templates. */
export const ListTemplates = async (req, res) => {
  const result = await templates.listTemplates(req.user.id, {
    category: req.query.category || null,
    q: req.query.q || null,
    workspaceId: req.query.workspaceId || null,
  });
  res.json(result);
};

/**
 * The one-off suggestions from section 33.
 *
 * Separate from the template list because they are prompts, not templates: nothing
 * to browse, and nothing to edit.
 */
export const ListSmartPrompts = async (req, res) => {
  res.json({ prompts: SMART_TEMPLATE_PROMPTS, kinds: SMART_CATEGORIES });
};

/** One template, including its body and the placeholders found in it. */
export const GetTemplate = async (req, res) => {
  const template = await templates.getTemplate(req.user.id, req.params.id, {
    workspaceId: req.query.workspaceId || null,
  });
  res.json({ template });
};

/** Create a document from a template. */
export const UseTemplate = async (req, res) => {
  const result = await templates.instantiateTemplate(req.user.id, req.params.id, {
    title: req.body?.title,
    values: valuesOf(req.body?.values),
    workspaceId: req.body?.workspaceId || null,
    folderId: req.body?.folderId || null,
  });
  res.status(201).json(result);
};

/** Save an existing document as a workspace template. */
export const SaveFromDocument = async (req, res) => {
  const template = await templates.saveFromDocument(req.user.id, req.body || {});
  res.status(201).json({ template });
};

/** Create a template directly. */
export const CreateTemplate = async (req, res) => {
  const template = await templates.createTemplate(req.user.id, req.body || {});
  res.status(201).json({ template });
};

/** Edit a workspace template. */
export const UpdateTemplate = async (req, res) => {
  const template = await templates.updateTemplate(req.user.id, req.params.id, req.body || {});
  res.json({ template });
};

/** Delete a workspace template. */
export const DeleteTemplate = async (req, res) => {
  await templates.deleteTemplate(req.user.id, req.params.id, {
    workspaceId: req.query.workspaceId || null,
  });
  res.json({ ok: true });
};

/** Generate a template structure from a prompt. */
export const GenerateTemplate = async (req, res) => {
  const result = await templates.generateTemplate(req.user.id, req.body || {});
  res.status(result.saved ? 201 : 200).json(result);
};

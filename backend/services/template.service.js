import mongoose from "mongoose";
import Template, { TEMPLATE_CATEGORIES } from "../models/Template.model.js";
import Document from "../models/doc.model.js";
import { ApiError } from "../utils/ApiError.js";
import { roleAtLeast } from "../models/WorkspaceMember.model.js";
import { memberRole, resolveWorkspace } from "./workspace.service.js";
import { authorize } from "./access.service.js";
import { createDocument, updateDocument } from "./document.service.js";
import * as provider from "./ai.provider.js";
import * as usage from "./usage.service.js";
import { BUILT_IN_TEMPLATES, SMART_CATEGORIES } from "../config/templates.js";

/**
 * Templates (master plan sections 32 and 33).
 *
 * Permissions mirror the folder service rather than inventing a new ladder:
 *  - browsing needs only a session, because the built-in library is public to any
 *    signed-in user and a workspace template is as visible as the workspace is;
 *  - creating, editing or deleting a workspace template needs `editor`, the same
 *    bar as adding a document, because a template is a way of adding documents;
 *  - using a template to create a document needs `editor` in the target workspace,
 *    which `createDocument` already enforces.
 *
 * Built-in templates are readable by everyone and immutable: an edit to one would
 * silently change the starting point for every other user's new document.
 */

/** Matches `{{placeholder}}`, allowing whitespace inside the braces. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Upper bound on a generated document body, to keep one prompt from bloating a doc. */
const MAX_GENERATED_CHARS = 40000;

/**
 * Resolve the workspace and assert the caller meets `minimum`.
 *
 * Built-ins need no workspace at all, so callers pass `null` to skip this.
 */
async function authorizeTemplateSpace(userId, workspaceId, minimum) {
  const workspace = await resolveWorkspace(userId, workspaceId);

  // A non-member gets a 404 rather than a 403, matching folders and workspaces:
  // this route should not confirm that another team's workspace exists.
  const role =
    String(workspace.owner) === String(userId) ? "owner" : await memberRole(workspace._id, userId);
  if (!role) throw new ApiError(404, "Workspace not found");
  if (!roleAtLeast(role, minimum)) {
    throw new ApiError(403, `You need the ${minimum} role in that workspace to manage templates`);
  }
  return workspace;
}

/**
 * Write any built-in template that is missing, and refresh its copy of the
 * definition.
 *
 * Deliberately overwrites built-ins: they are shipped content, so a definition fix
 * has to reach installs that already have the row. Workspace templates are never
 * touched, so nothing a team saved is lost.
 */
export async function ensureBuiltIns({ force = false } = {}) {
  // `listTemplates` calls this on every browse, so the cheap check comes first:
  // counting first avoids a twelve-document bulkWrite on the common path, where
  // the library is already seeded.
  if (!force) {
    const seeded = await Template.countDocuments({ builtIn: true });
    if (seeded >= BUILT_IN_TEMPLATES.length) return seeded;
  }

  const ops = BUILT_IN_TEMPLATES.map((t) => ({
    updateOne: {
      filter: { builtIn: true, title: t.title },
      update: { $set: { ...t, workspace: null, owner: null, builtIn: true } },
      upsert: true,
    },
  }));
  await Template.bulkWrite(ops, { ordered: false });
  return BUILT_IN_TEMPLATES.length;
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * Unknown placeholders are left untouched on purpose: that is what a template
 * author sees when a field was renamed, which is far easier to spot than a silent
 * blank. Placeholders the client did declare get emptied instead, so a half-filled
 * form does not leak `{{client_name}}` into a letter.
 */
export function mergeFields(content, fields = [], values = {}) {
  const known = new Set(fields.map((f) => f.name));
  const declared = new Set(Object.keys(values));

  return String(content ?? "").replace(PLACEHOLDER, (match, name) => {
    if (declared.has(name)) {
      const value = values[name];
      return value === null || value === undefined ? "" : String(value);
    }
    return known.has(name) ? "" : match;
  });
}

/** Every placeholder in a body, in order of first appearance and deduplicated. */
export function placeholdersIn(content) {
  const found = [];
  for (const m of String(content ?? "").matchAll(PLACEHOLDER)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Turn a multi-line value into a bullet list.
 *
 * The built-ins ask for "one per line" in the field hint, and a template body is
 * plain HTML, so a pasted list would otherwise arrive as one run-on paragraph.
 */
function toList(value) {
  const items = String(value ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (items.length < 2) return `<p>${String(value ?? "")}</p>`;
  return `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

/**
 * Replace a filled field with either a paragraph or a bullet list.
 *
 * Applied after the plain substitution, because it has to see the value rather
 * than the placeholder. Line breaks in a value become `<br>`; the value is
 * inserted as-is, since it came from a caller that already owns the template.
 */
function renderFilledContent(content, values) {
  const out = [];
  let cursor = 0;

  for (const m of String(content ?? "").matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!Object.hasOwn(values, name)) continue;
    out.push(content.slice(cursor, m.index));
    const value = values[name];
    const text = value === null || value === undefined ? "" : String(value);
    const isList = text.includes("\n") && text.split(/\n+/).filter((l) => l.trim()).length > 1;
    out.push(isList ? toList(text) : `<p>${text.replace(/\n/g, "<br>")}</p>`);
    cursor = m.index + m[0].length;
  }
  out.push(content.slice(cursor));
  return out.join("");
}

/**
 * Fill in a template's fields. `values` wins over the template's own field list,
 * so a caller can merge a value into a template that never declared it.
 */
export function fillTemplate(template, values = {}) {
  const content = template.content ?? "";
  const fields = Array.isArray(template.fields) ? template.fields : [];
  const declared = {};
  for (const f of fields) if (Object.hasOwn(values, f.name)) declared[f.name] = values[f.name];

  // Fields the template declares but the caller did not supply are filled with an
  // empty string: the placeholder is known, so leaving it visible would ship a
  // template's internals into the finished document.
  const filled = renderFilledContent(content, declared);
  const merged = mergeFields(filled, fields, values);
  return merged.length > MAX_GENERATED_CHARS ? merged.slice(0, MAX_GENERATED_CHARS) : merged;
}

/**
 * Shape a template for the response, so the client needs one query for the grid.
 *
 * `includeContent` is opt-in. The browse response leaves the body out: the grid
 * renders cards, and shipping every template's full HTML on each browse is
 * wasteful for a library of twelve. The single-template endpoint includes it.
 */
function describe(template, { includeContent = false } = {}) {
  const plain = template.toObject ? template.toObject() : template;
  return {
    _id: plain._id,
    title: plain.title,
    description: plain.description ?? "",
    category: plain.category,
    icon: plain.icon ?? "",
    tags: plain.tags ?? [],
    fields: plain.fields ?? [],
    ...(includeContent ? { content: plain.content ?? "" } : {}),
    workspace: plain.workspace ?? null,
    owner: plain.owner ?? null,
    builtIn: !!plain.builtIn,
    useCount: plain.useCount ?? 0,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

/**
 * Browse templates: the built-in library plus the caller's workspace templates.
 *
 * `workspaceId` picks one workspace; with none, the caller's own active workspace
 * is used, so the picker shows team templates by default without the client having
 * to know which workspace it is looking at.
 */
export async function listTemplates(userId, { category = null, q = null, workspaceId = null } = {}) {
  await ensureBuiltIns();

  const workspace = await authorizeTemplateSpace(userId, workspaceId, "viewer").catch((err) => {
    // Browsing the built-in library must not fail because the caller has no
    // workspace yet, so a missing or off-limits workspace only drops team
    // templates rather than the whole response.
    if (err.status === 404 || err.status === 403) return null;
    throw err;
  });

  const filter = { $or: [{ builtIn: true }, ...(workspace ? [{ workspace: workspace._id }] : [])] };
  if (category) filter.category = category;
  if (q) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ title: rx }, { description: rx }, { tags: rx }] }];
  }

  const templates = await Template.find(filter).sort({ builtIn: -1, useCount: -1, title: 1 }).lean();

  return {
    categories: TEMPLATE_CATEGORIES,
    templates: templates.map((t) => describe(t)),
  };
}

/** One template with its body, for the preview and fill-in form. */
export async function getTemplate(userId, templateId, { workspaceId = null } = {}) {
  const template = await Template.findById(templateId);
  if (!template) throw new ApiError(404, "Template not found");
  if (!template.builtIn) {
    await authorizeTemplateSpace(userId, workspaceId || template.workspace, "viewer");
  }
  return {
    ...describe(template, { includeContent: true }),
    placeholders: placeholdersIn(template.content),
  };
}

/**
 * Save an existing document as a workspace template.
 *
 * The body is copied, not referenced, so later edits to the document leave the
 * template alone -- that is the point of freezing a template.
 */
export async function saveFromDocument(
  userId,
  { documentId, title, category = "Custom", description = "", tags = [] } = {}
) {
  const { doc } = await authorize(documentId, userId, "viewer");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  const workspace = await authorizeTemplateSpace(userId, doc.workspace, "editor");

  const name = String(title || doc.title).trim().slice(0, 160);
  if (!name) throw new ApiError(400, "Template title is required");

  // Re-saving under a name the workspace already uses would be caught by the
  // unique index as a bare E11000; turn it into a message the UI can show.
  const clash = await Template.findOne({ workspace: workspace._id, title: name, builtIn: false })
    .lean();
  if (clash) throw new ApiError(409, "This workspace already has a template with that title");

  const template = await Template.create({
    title: name,
    description: String(description || "").slice(0, 400),
    category: TEMPLATE_CATEGORIES.includes(category) ? category : "Custom",
    content: doc.content || "",
    fields: [],
    workspace: workspace._id,
    owner: userId,
    builtIn: false,
    tags: (Array.isArray(tags) ? tags : []).slice(0, 8).map((t) => String(t).slice(0, 40)),
  });

  return describe(template);
}

/** Create a workspace template from a body supplied directly. */
export async function createTemplate(
  userId,
  { title, content = "", description = "", category = "Custom", icon = "", tags = [], fields = [], workspaceId = null } = {}
) {
  const workspace = await authorizeTemplateSpace(userId, workspaceId, "editor");

  const name = String(title || "").trim().slice(0, 160);
  if (!name) throw new ApiError(400, "Template title is required");

  const clash = await Template.findOne({ workspace: workspace._id, title: name, builtIn: false })
    .lean();
  if (clash) throw new ApiError(409, "This workspace already has a template with that title");

  const template = await Template.create({
    title: name,
    description: String(description || "").slice(0, 400),
    category: TEMPLATE_CATEGORIES.includes(category) ? category : "Custom",
    icon: String(icon || "").slice(0, 8),
    content: String(content || "").slice(0, MAX_GENERATED_CHARS),
    fields: sanitizeFields(fields),
    workspace: workspace._id,
    owner: userId,
    builtIn: false,
    tags: (Array.isArray(tags) ? tags : []).slice(0, 8).map((t) => String(t).slice(0, 40)),
  });

  return describe(template);
}

/** Keep only the field attributes the model declares. */
function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, 40).map((f) => ({
    name: String(f?.name || "").trim().slice(0, 60),
    label: String(f?.label || f?.name || "").trim().slice(0, 120),
    type: ["text", "textarea", "date", "number", "select"].includes(f?.type) ? f.type : "text",
    options: (Array.isArray(f?.options) ? f.options : []).slice(0, 20).map((o) => String(o).slice(0, 60)),
    hint: String(f?.hint || "").slice(0, 240),
    required: !!f?.required,
  })).filter((f) => f.name);
}

/** Edit a workspace template. Built-ins are refused. */
export async function updateTemplate(
  userId,
  templateId,
  { title, description, category, icon, tags, fields, workspaceId = null } = {}
) {
  const template = await Template.findById(templateId);
  if (!template) throw new ApiError(404, "Template not found");
  if (template.builtIn) throw new ApiError(400, "Built-in templates cannot be edited");

  await authorizeTemplateSpace(userId, workspaceId || template.workspace, "editor");

  if (title !== undefined) {
    const name = String(title).trim().slice(0, 160);
    if (!name) throw new ApiError(400, "Template title is required");
    template.title = name;
  }
  if (description !== undefined) template.description = String(description).slice(0, 400);
  if (category !== undefined) {
    if (!TEMPLATE_CATEGORIES.includes(category)) throw new ApiError(400, "Unknown template category");
    template.category = category;
  }
  if (icon !== undefined) template.icon = String(icon).slice(0, 8);
  if (tags !== undefined) {
    template.tags = (Array.isArray(tags) ? tags : []).slice(0, 8).map((t) => String(t).slice(0, 40));
  }
  if (fields !== undefined) template.fields = sanitizeFields(fields);

  await template.save();
  return describe(template);
}

/** Delete a workspace template. Built-ins are refused. */
export async function deleteTemplate(userId, templateId, { workspaceId = null } = {}) {
  const template = await Template.findById(templateId);
  if (!template) throw new ApiError(404, "Template not found");
  if (template.builtIn) throw new ApiError(400, "Built-in templates cannot be deleted");

  await authorizeTemplateSpace(userId, workspaceId || template.workspace, "admin");
  await template.deleteOne();
}

/**
 * Create a document from a template.
 *
 * A built-in template can be used in any workspace the caller can edit in; a
 * workspace template is only usable in its own workspace, so one team's letters
 * cannot be dropped into another's library.
 */
export async function instantiateTemplate(
  userId,
  templateId,
  { title, values = {}, workspaceId = null, folderId = null } = {}
) {
  const template = await Template.findById(templateId);
  if (!template) throw new ApiError(404, "Template not found");

  const targetWorkspaceId = template.builtIn ? workspaceId : template.workspace;
  const workspace = await authorizeTemplateSpace(userId, targetWorkspaceId, "editor");

  const docTitle = String(title || template.title).trim().slice(0, 160) || "Untitled";
  const content = fillTemplate(template, values || {});

  // Reuse the document service so a template-created document gets the same plan
  // quota, folder checks and title defaulting as one made from the sidebar.
  const doc = await createDocument(userId, {
    title: docTitle,
    workspaceId: workspace._id,
    folderId,
  });

  if (content) {
    await updateDocument(doc._id, userId, { content });
  }

  // Track popularity for the "most used" ordering. Failure here must not lose the
  // document the user just created, so the counter is best effort.
  await Template.updateOne({ _id: template._id }, { $inc: { useCount: 1 } }).catch(() => {});

  const filled = await Document.findById(doc._id).lean();
  return {
    ...describe(template),
    content,
    document: {
      _id: filled._id,
      title: filled.title,
      workspace: filled.workspace,
      folder: filled.folder ?? null,
      content: filled.content ?? "",
      updatedAt: filled.updatedAt,
    },
  };
}

/**
 * Smart templates (master plan section 33).
 *
 * A prompt like "Create a software proposal" becomes a ready-made template: the
 * model returns a title, category, section headings and any placeholders worth
 * asking the user for. The result is saved into the caller's workspace like any
 * other template, so the AI is a starting point rather than a one-off.
 *
 * The generation counts against the AI quota like the writing assistant does.
 */
export async function generateTemplate(userId, params = {}) {
  const { prompt, title, category, description = "", save = true, workspaceId = null } = params;

  const workspace = await authorizeTemplateSpace(userId, workspaceId, "editor");

  const wanted = String(prompt || title || "").trim().slice(0, 2000);
  if (!wanted) throw new ApiError(400, "Describe the document you want");

  const cat = SMART_CATEGORIES.find((c) => c.id === category) || null;
  if (category && !cat) throw new ApiError(400, "Unknown template kind");

  await usage.assertWithinQuota(userId, workspace._id);

  const result = await provider.generateTemplateStructure({
    prompt: wanted,
    category: cat?.category || "Business",
    kind: cat?.label || "",
  });

  const generatedTitle = String(title || result.title || "").trim().slice(0, 160);
  if (!generatedTitle) throw new ApiError(502, "The AI did not return a usable title");

  const finalTitle = await uniqueTemplateTitle(workspace._id, generatedTitle);
  const content = String(result.content || "").slice(0, MAX_GENERATED_CHARS);
  const fields = sanitizeFields(result.fields);
  const categoryName = TEMPLATE_CATEGORIES.includes(result.category) ? result.category : "Custom";

  // Only persist when asked: the picker shows the draft first, and a user who
  // dislikes the result should not be left with a template in the list.
  if (!save) {
    return {
      saved: false,
      draft: {
        title: finalTitle,
        description: String(result.description || description || "").slice(0, 400),
        category: categoryName,
        content,
        fields,
        tags: (result.tags || []).slice(0, 8),
        placeholders: placeholdersIn(content),
      },
      mock: !!result.mock,
    };
  }

  const template = await Template.create({
    title: finalTitle,
    description: String(result.description || description || "").slice(0, 400),
    category: categoryName,
    content,
    fields,
    icon: cat ? "✨" : "",
    tags: (result.tags || []).slice(0, 8).map((t) => String(t).slice(0, 40)),
    workspace: workspace._id,
    owner: userId,
    builtIn: false,
  });

  // The body is returned here as well, because the picker shows a preview of what
  // was just generated instead of making the client fetch it back.
  return { saved: true, ...describe(template, { includeContent: true }), mock: !!result.mock };
}

/** Append a number rather than failing on the workspace's unique title index. */
async function uniqueTemplateTitle(workspaceId, title) {
  const taken = await Template.find({ workspace: workspaceId, title: title }).lean();
  if (taken.length === 0) return title;
  for (let n = 2; n <= 50; n += 1) {
    const candidate = `${title} (${n})`;
    const clash = await Template.exists({ workspace: workspaceId, title: candidate });
    if (!clash) return candidate;
  }
  return `${title} (${Date.now()})`;
}

export { describe as describeTemplate };

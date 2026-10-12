import mongoose from "mongoose";

/**
 * Templates (master plan section 32, the `Template` model in section 35, and the
 * `/api/v1/templates` route in section 38).
 *
 * Two kinds live in one collection because they answer the same question in the
 * same place:
 *
 *  - **Built-in** templates are `builtIn: true` with a null `workspace` and a null
 *    `owner`. They ship with the app, are visible to every signed-in user, and are
 *    not editable or deletable -- otherwise one user's edit would change what
 *    everybody else sees.
 *  - **Workspace** templates belong to a workspace and are managed like anything
 *    else in it: anyone with `editor` may add or change them, and `admin` may
 *    remove them. A workspace template is usually made from a document that already
 *    exists and is shaped the way the team wants it.
 *
 * `fields` declares the placeholders in `content` so the client can render a form
 * before the document exists. `{{name}}` in the content is replaced by the matching
 * value; a placeholder with no value becomes an empty string rather than being
 * left visible, so a half-filled template does not leak `{{client_name}}` into a
 * letter.
 */

/** The categories from section 32, plus "custom" for templates a team saves. */
export const TEMPLATE_CATEGORIES = ["Blank", "Business", "Education", "Personal", "Custom"];

/**
 * Placeholder kinds the form knows how to render. Kept to what the built-ins
 * actually need so the client does not have to guess at an unknown type.
 */
export const FIELD_TYPES = ["text", "textarea", "date", "number", "select"];

const templateFieldSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: FIELD_TYPES, default: "text" },
    /** Only for `select`. */
    options: { type: [String], default: [] },
    /** Shown under the input; also the hint the AI generator is given. */
    hint: { type: String, default: "" },
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: "", trim: true, maxlength: 400 },
    category: { type: String, enum: TEMPLATE_CATEGORIES, default: "Custom", index: true },
    /**
     * The document body as editor HTML. A template with no content is still valid
     * -- "Blank Document" is exactly that.
     */
    content: { type: String, default: "" },
    fields: { type: [templateFieldSchema], default: [] },
    /** Single character or emoji used in the picker grid. */
    icon: { type: String, default: "", maxlength: 8 },
    tags: { type: [String], default: [], index: true },

    /** Null on built-ins, which belong to no workspace. */
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    /** Null on built-ins. */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    builtIn: { type: Boolean, default: false, index: true },

    /** How many times this template has been used; drives "Popular" ordering. */
    useCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// The picker loads built-ins and the caller's workspace templates in one query.
templateSchema.index({ builtIn: 1, workspace: 1, category: 1 });

// A workspace cannot hold two templates with the same title, which is what stops
// repeated "save as template" from filling the list with duplicates. Built-ins are
// excluded because they share the same null workspace.
templateSchema.index(
  { workspace: 1, title: 1 },
  { unique: true, partialFilterExpression: { builtIn: false } }
);

const Template = mongoose.model("Template", templateSchema);
export default Template;

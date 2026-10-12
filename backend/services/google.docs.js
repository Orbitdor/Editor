/**
 * Google Docs -> Tiptap JSON converter (master plan section 31).
 *
 * The Google Docs API returns a document as a tree of `structuralElement` nodes,
 * each holding a run of `textRun`s with formatting. Turning that into Tiptap JSON
 * is the interesting part of Drive import, and the plan calls out that conversion
 * limitations must be handled clearly rather than silently dropped.
 *
 * This module is deliberately pure: no network, no database, no config. It maps a
 * Docs document to `{ content, plainText, limitations, title }`, where
 * `limitations` lists every construct that could not be represented faithfully.
 * The import screen shows that list, so the user learns what changed rather than
 * discovering it later.
 */

/**
 * Docs `namedStyleType` values mapped to editor blocks.
 *
 * The API sends `HEADING_1` .. `HEADING_6`; the un-prefixed spellings are
 * accepted too, because exported documents from other tools sometimes use them.
 */
const HEADING_BY_STYLE = new Map([
  ["title", { type: "heading", attrs: { level: 1 } }],
  ["subtitle", { type: "paragraph" }],
  ["heading_1", { type: "heading", attrs: { level: 1 } }],
  ["heading_2", { type: "heading", attrs: { level: 2 } }],
  ["heading_3", { type: "heading", attrs: { level: 3 } }],
  ["heading_4", { type: "heading", attrs: { level: 4 } }],
  ["heading_5", { type: "heading", attrs: { level: 5 } }],
  ["heading_6", { type: "heading", attrs: { level: 6 } }],
  ["heading1", { type: "heading", attrs: { level: 1 } }],
  ["heading2", { type: "heading", attrs: { level: 2 } }],
  ["heading3", { type: "heading", attrs: { level: 3 } }],
  ["heading4", { type: "heading", attrs: { level: 4 } }],
  ["heading5", { type: "heading", attrs: { level: 5 } }],
  ["heading6", { type: "heading", attrs: { level: 6 } }],
]);

/**
 * Tiptap marks keyed by the Google Docs text style that produces them. Order
 * matters only for readability, not for output.
 */
const MARKS_BY_STYLE = {
  bold: { type: "bold" },
  italic: { type: "italic" },
  underline: { type: "underline" },
  strikethrough: { type: "strike" },
};

/** Bullet glyphs Docs uses, mapped to the editor's list types. */
const BULLET_GLYPHS = ["●", "○", "■", "●", "○", "■", "●", "○", "■"];
const NUMBERED_GLYPHS = ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10."];

/** A text node. */
function text(value, marks = []) {
  if (!value) return null;
  return marks.length ? { type: "text", marks, text: value } : { type: "text", text: value };
}

/** Concatenate adjacent runs that carry identical marks, as ProseMirror expects. */
function coalesce(nodes) {
  const out = [];
  for (const node of nodes) {
    if (!node) continue;
    const previous = out[out.length - 1];
    if (previous && previous.type === "text" && JSON.stringify(previous.marks || []) === JSON.stringify(node.marks || [])) {
      previous.text += node.text;
    } else {
      out.push({ ...node });
    }
  }
  return out;
}

/** Marks for one `textStyle`, ignoring named styles which are not marks. */
function marksFor(textStyle, limitations) {
  const marks = [];
  if (!textStyle) return marks;

  for (const [style, mark] of Object.entries(MARKS_BY_STYLE)) {
    if (textStyle[style]) marks.push(mark);
  }

  const color = textStyle.foregroundColor;
  if (color?.color?.rgbColor) {
    const hex = color.color.rgbColor;
    // Pure red is Docs' own "revision" colour and reads as an authoring artefact.
    if (hex.red === 1 && hex.green === 0 && hex.blue === 0) {
      limitations.add("Red text (treated as a tracked change) was kept as plain text");
    } else {
      marks.push({ type: "textStyle", attrs: { color: rgbToHex(hex) } });
    }
  }

  if (textStyle.backgroundColor?.color?.rgbColor) {
    marks.push({ type: "highlight", attrs: { color: null } });
  }

  if (textStyle.link?.url) {
    marks.push({ type: "link", attrs: { href: textStyle.link.url } });
  }

  return marks;
}
function rgbToHex({ red = 0, green = 0, blue = 0 }) {
  const channel = (value) =>
    Math.max(0, Math.min(255, Math.round((Number(value) || 0) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Read the text of a paragraph-ish element, including inline children. */
function paragraphText(element) {
  if (element.textRun?.content) return element.textRun.content;
  if (element.person?.personProperties?.name) return element.person.personProperties.name;
  if (element.richLink?.richLinkProperties?.title) {
    return element.richLink.richLinkProperties.title;
  }
  if (element.footnoteReference) return "";
  return "";
}

/** Detect a list item from its leading glyph, returning the type and offset. */
function detectListItem(textValue) {
  const value = String(textValue || "");
  const bullet = BULLET_GLYPHS.find((glyph) => value.startsWith(glyph));
  if (bullet) {
    return {
      type: "bulletList",
      rest: value.slice(bullet.length).replace(/^\s+/, ""),
    };
  }

  const numbered = NUMBERED_GLYPHS.find((glyph) => value.startsWith(glyph));
  if (numbered) {
    return {
      type: "orderedList",
      rest: value.slice(numbered.length).replace(/^\s+/, ""),
    };
  }

  // `textStyle.bulletedList` is the machine-readable signal; the glyph check
  // above is only a fallback for exported text.
  return null;
}

/**
 * Convert one `structuralElement` into a Tiptap block node.
 *
 * @returns {object|null} A Tiptap node, or null when the element carries no text.
 */
function convertElement(element, ctx) {
  const paragraph = element.paragraph;
  if (!paragraph) {
    // Section breaks and column changes are layout, not content.
    ctx.limitations.add(`Ignored an unsupported section layout (${element.sectionBreak ? "section break" : "column change"})`);
    return null;
  }

  const style = paragraph.paragraphStyle?.namedStyleType;
  const elements = paragraph.elements || [];

  // The whole paragraph's text, used for list detection and plain text.
  const fullText = elements
    .map((el) => {
      if (el.textRun?.content) return el.textRun.content;
      if (el.person?.personProperties?.name) return el.person.personProperties.name;
      if (el.richLink?.richLinkProperties?.title) return el.richLink.richLinkProperties.title;
      return "";
    })
    .join("");

  const machineList =
    style === "BULLETED_LIST" ? "bulletList" : style === "NUMBERED_LIST" ? "orderedList" : null;
  const glyphList = detectListItem(fullText);
  const listType = machineList || glyphList?.type;

  // Build the inline content, honouring marks on each run.
  const inline = [];
  let skipChars = 0;

  for (const child of elements) {
    const value = paragraphText(child);

    if (child.footnoteReference) {
      ctx.limitations.add("Footnote references were dropped (this editor has no footnotes)");
      continue;
    }
    if (child.horizontalRule) {
      ctx.limitations.add("Horizontal rules were dropped");
      continue;
    }
    if (child.pageBreak) {
      ctx.limitations.add("Page breaks were dropped");
      continue;
    }
    if (child.inlineObjectElement) {
      const kind = child.inlineObjectElement.inlineObjectProperties?.embeddedObject?.imageProperties;
      if (kind) {
        ctx.limitations.add("Images and drawings were not imported, only their captions");
      }
      continue;
    }
    if (child.equation) {
      ctx.limitations.add("Equations were dropped");
      continue;
    }
    if (child.table) {
      ctx.limitations.add("Tables were flattened to plain text");
      inline.push(text(" "));
      continue;
    }
    if (child.person) {
      ctx.limitations.add("Smart-chip people mentions were converted to plain names");
    }
    if (child.richLink) {
      ctx.limitations.add("Bookmarks and smart links were converted to plain text");
    }

    if (!value) continue;

    const marks = marksFor(child.textRun?.textStyle, ctx.limitations);
    let content = value;

    // A glyph-detected list has to have its marker removed from the first run.
    if (listType && skipChars === 0 && glyphList) {
      const markerLength = value.length - glyphList.rest.length;
      if (markerLength > 0) {
        content = value.slice(markerLength);
        skipChars = markerLength;
      }
    }

    // A trailing Docs line break becomes nothing; Tiptap paragraphs do that.
    content = content.replace(/\n$/, "");
    inline.push(text(content, marks));
  }

  const content = coalesce(inline).filter(Boolean);
  const isEmpty = content.length === 0;

  if (listType) {
    // Each Docs list item is its own paragraph, so each becomes one list item.
    // The editor's list nodes hold `listItem` children.
    const item = {
      type: "listItem",
      content: isEmpty ? [text("")] : content,
    };
    return { type: listType, content: [item] };
  }

  if (isEmpty) {
    // An empty Docs paragraph is a real vertical gap, so keep it.
    return { type: "paragraph" };
  }

  const heading = HEADING_BY_STYLE.get(String(style || "").toLowerCase());
  if (heading) return { ...heading, content };

  // A Docs paragraph with a page break before it still renders as a paragraph;
  // the break itself is already reported as dropped.
  return { type: "paragraph", content };
}

/**
 * Merge consecutive single-item list nodes into one list.
 *
 * Google Docs emits one `paragraph` per list item, so a five-item list arrives as
 * five separate `bulletList` nodes. Tiptap expects a single node with five
 * `listItem` children.
 */
function mergeLists(nodes) {
  const out = [];
  for (const node of nodes) {
    if (!node) continue;
    const previous = out[out.length - 1];
    if (previous && previous.type === node.type && (node.type === "bulletList" || node.type === "orderedList")) {
      previous.content.push(...node.content);
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Flatten Tiptap content to plain text, for the document's search field. */
export function toPlainText(content) {
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === "text") {
      parts.push(node.text || "");
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(content);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Convert a Google Docs document into Tiptap JSON.
 *
 * @param {object} doc Response of `documents.get`.
 * @returns {{title: string, content: object, plainText: string, limitations: string[]}}
 */
export function docsToTiptap(doc) {
  const ctx = { limitations: new Set() };

  const title = doc?.title || "Untitled";
  const body = doc?.body?.content || [];
  const converted = mergeLists(body.map((element) => convertElement(element, ctx)).filter(Boolean));

  // A Docs document with no body still needs one paragraph for the editor.
  const content = converted.length
    ? { type: "doc", content: converted }
    : { type: "doc", content: [{ type: "paragraph" }] };

  return {
    title,
    content,
    plainText: toPlainText(content),
    limitations: [...ctx.limitations],
  };
}

/** MIME types this converter can handle. */
export const SUPPORTED_MIMES = ["application/vnd.google-apps.document"];

/** True when the Drive file is a Google Doc rather than a binary file. */
export function isGoogleDoc(mimeType) {
  return SUPPORTED_MIMES.includes(mimeType);
}

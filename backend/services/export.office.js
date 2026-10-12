import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";

/**
 * Office export (master plan section 28): DOCX and PDF from the same source.
 *
 * The approach is one parser and two renderers. The document's content is
 * Tiptap HTML, and each output format wants a different tree, so instead of
 * writing an HTML walker per format -- three places to keep in step, and three
 * places for the same heading bug to live -- the HTML is converted once into a
 * small neutral block model and each renderer walks that.
 *
 * The model is deliberately boring: blocks containing runs of text, where a run
 * carries its own styling. That covers headings, lists, quotes, code, tables,
 * images and page breaks, which is the whole of section 28's list.
 */

const VOID_TAGS = new Set([
  "br", "hr", "img", "input", "meta", "link", "source", "col", "area", "base",
]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
};

/** Decode the HTML entities Tiptap actually emits, plus numeric ones. */
function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    const found = ENTITIES[body.toLowerCase()];
    return found === undefined ? match : found;
  });
}

/** Tags that open a new block, and the block they open. */
const BLOCK_TAGS = {
  p: "paragraph", h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading",
  blockquote: "quote", pre: "code",
};

/**
 * Parse the document HTML into blocks.
 *
 * This is a scanner rather than a full DOM parser on purpose: the input is our
 * own Tiptap output, so it is well-formed, and pulling a parser dependency in for
 * it would be more moving parts than the problem deserves.
 */
export function htmlToBlocks(html = "") {
  const source = String(html);
  const blocks = [];
  let runs = [];
  let listStack = [];
  let table = null;
  let row = null;
  let cell = null;
  let preBuffer = null;

  /**
   * Inline styling is a stack, not a sticky flag.
   *
   * The naive version -- tag the last run and hope -- gets "Hello **bold** and
   * it" right for the word and wrong for everything after it, because the style
   * has no closing event. Nesting `<strong><em>x</em>y</strong>` needs a real
   * push and pop, so that is what this is.
   */
  const styleStack = [{}];
  const currentStyle = () => ({ ...styleStack[styleStack.length - 1] });

  const currentRuns = () => (cell ? cell.runs : runs);

  const flushRuns = () => {
    if (!runs.length) return;
    const trimmed = trimRuns(runs);
    if (trimmed.length) blocks.push({ type: "paragraph", runs: trimmed });
    runs = [];
  };

  const pushBlock = (block) => {
    flushRuns();
    blocks.push(block);
  };

  // Walk the string once, reacting to tags and text in the order they appear.
  const tagPattern = /<\/?([a-zA-Z0-9-]+)((?:\s+[^>]*?)?)\/?>/g;
  let cursor = 0;
  let match;

  while ((match = tagPattern.exec(source)) !== null) {
    const text = source.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    if (text) appendText(currentRuns(), decodeEntities(text), preBuffer, currentStyle());

    const [full, rawName, attrsRaw] = match;
    const name = rawName.toLowerCase();
    const closing = full.startsWith("</");

    if (name === "br") {
      currentRuns().push({ text: "\n" });
      continue;
    }

    if (name === "hr") {
      pushBlock({ type: "hr" });
      continue;
    }

    if (name === "img" && !closing) {
      const attrs = parseAttrs(attrsRaw || "");
      const block = {
        type: "image",
        src: attrs.src || "",
        alt: attrs.alt || "",
        width: attrs.width ? Number(attrs.width) : null,
        height: attrs.height ? Number(attrs.height) : null,
        attachmentId: attachmentIdFromSrc(attrs.src || ""),
      };
      // Inside a table cell an image would break the row model, so it becomes a
      // caption line instead of being dropped silently.
      if (cell) cell.runs.push({ text: `[image: ${attrs.alt || "attachment"}]` });
      else pushBlock(block);
      continue;
    }

    if (name === "div" && !closing) {
      const attrs = parseAttrs(attrsRaw || "");
      if (attrs["data-pagebreak"] === "1") {
        pushBlock({ type: "pagebreak" });
        continue;
      }
      if (attrs["data-attachment-id"]) {
        pushBlock({
          type: "attachment",
          name: attrs["data-name"] || "Attachment",
          mime: attrs["data-mime"] || "",
          bytes: attrs["data-bytes"] ? Number(attrs["data-bytes"]) : null,
          attachmentId: attrs["data-attachment-id"],
        });
        continue;
      }
      continue;
    }

    if (name === "ul" || name === "ol") {
      if (closing) {
        const open = listStack.pop();
        // Nested lists are emitted as their own block rather than as indented
        // children; the two formats differ enough in how they nest that a flat
        // sequence is the honest rendering.
        if (open && open.items.length) blocks.push({ type: "list", ...open });
      } else {
        flushRuns();
        listStack.push({ ordered: name === "ol", items: [] });
      }
      continue;
    }

    if (name === "li") {
      if (closing) {
        const open = listStack[listStack.length - 1];
        const item = trimRuns(cell ? cell.runs : runs);
        if (open) open.items.push(item);
        else blocks.push({ type: "list", ordered: false, items: [item] });
        // An empty item still has to appear, or a bulleted list silently loses
        // its blank rows.
        if (!cell) runs = [];
      } else {
        // A new item starts with an empty run buffer; whatever accumulated
        // between two `<li>` tags belongs to this one.
        runs = [];
        if (cell) cell.runs = [];
      }
      continue;
    }

    if (name === "table") {
      if (closing) {
        if (table && table.rows.length) pushBlock(table);
        table = null;
        row = null;
        cell = null;
      } else {
        flushRuns();
        table = { type: "table", rows: [] };
      }
      continue;
    }

    if (name === "tr") {
      if (closing) row = null;
      else {
        row = { cells: [] };
        if (table) table.rows.push(row);
      }
      continue;
    }

    if (name === "th" || name === "td") {
      if (closing) {
        if (row && cell) {
          row.cells.push({ header: name === "th", runs: trimRuns(cell.runs) });
        }
        cell = null;
      } else if (row) {
        cell = { runs: [] };
      }
      continue;
    }

    if (name === "pre") {
      if (closing) {
        const text = (preBuffer || []).join("");
        preBuffer = null;
        pushBlock({ type: "code", text });
      } else {
        preBuffer = [];
      }
      continue;
    }

    if (BLOCK_TAGS[name]) {
      if (closing) {
        if (name === "pre") continue; // handled above
        const openName = name === "p" ? "p" : name;
        if (openName === "pre") continue;
        const inline = trimRuns(currentRuns());
        if (inline.length) {
          if (name.startsWith("h")) {
            blocks.push({ type: "heading", level: Number(name[1]), runs: inline });
          } else if (name === "blockquote") {
            blocks.push({ type: "quote", runs: inline });
          } else {
            blocks.push({ type: "paragraph", runs: inline });
          }
        }
        if (!cell) runs = [];
      } else {
        flushRuns();
        runs = [];
      }
      continue;
    }

    // Every inline tag pushes its style on the way in and pops it on the way out.
// Anything the parser does not recognise is treated as having no style, which
// is why an unknown wrapper does not silently bold the rest of the document.
if (closing) {
      if (styleStack.length > 1) styleStack.pop();
      continue;
    }
    styleStack.push({ ...currentStyle(), ...styleFor(name, parseAttrs(attrsRaw || "")) });
  }

  appendText(currentRuns(), decodeEntities(source.slice(cursor)), preBuffer, currentStyle());
  flushRuns();

  // A list still open at the end of the document has no closing tag, which
  // happens when the editor serialises mid-edit.
  while (listStack.length) {
    const open = listStack.pop();
    if (open.items.length) blocks.push({ type: "list", ...open });
  }

  return blocks;
}

function appendText(target, text, preBuffer, style = {}) {
  if (preBuffer) {
    preBuffer.push(text);
    return;
  }
  if (!text) return;
  // The style comes from the stack, not from the previous run: that is what
  // stops a run from inheriting the formatting of whatever closed just before it.
  target.push({ ...style, text });
}

function trimRuns(list) {
  const copy = list.filter((run) => run.text !== "" && run.text !== undefined);
  if (copy.length) {
    copy[0] = { ...copy[0], text: copy[0].text.replace(/^\s+/, "") };
    copy[copy.length - 1] = {
      ...copy[copy.length - 1],
      text: copy[copy.length - 1].text.replace(/\s+$/, ""),
    };
  }
  return copy.filter((run) => run.text !== "");
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return attrs;
}

/** The style an inline tag contributes, as a delta to be merged onto the stack. */
function styleFor(tagName, attrs) {
  const style = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(attrs, key);

  if (["strong", "b"].includes(tagName) || attrs["data-bold"] === "true") style.bold = true;
  if (["em", "i"].includes(tagName) || attrs["data-italic"] === "true") style.italic = true;
  if (["s", "strike", "del"].includes(tagName)) style.strike = true;
  if (tagName === "code") style.code = true;
  if (tagName === "sup") style.sup = true;
  if (tagName === "sub") style.sub = true;
  if (tagName === "a" && attrs.href) style.link = attrs.href;
  if (has("data-color")) style.color = attrs["data-color"];
  // Tiptap stores font size as pixels in `data-font-size`.
  if (has("data-font-size")) {
    const px = parseFloat(attrs["data-font-size"]);
    if (Number.isFinite(px) && px > 0) style.size = px;
  }
  if (tagName === "mark" || has("data-highlight")) style.highlight = true;

  return style;
}

/** Pull the attachment id out of one of our own content URLs. */
function attachmentIdFromSrc(src) {
  const match = /\/api\/v1\/attachments\/([a-f0-9]{24})/i.exec(src || "");
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find a TrueType font with real Unicode coverage.
 *
 * The standard PDF fonts are WinAnsi only, which would turn the Urdu and
 * Devanagari text this app explicitly supports into question marks. A real font
 * file avoids that. Bundled fonts win; otherwise a short list of the places
 * Linux and Windows keep them is tried, and PDF_FONT_PATH overrides everything.
 */
function resolveFontFile() {
  const candidates = [
    process.env.PDF_FONT_PATH,
    path.join(HERE, "..", "assets", "fonts", "NotoSans-Regular.ttf"),
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable path is simply not a match.
    }
  }
  return null;
}

let cachedFont;

/** Register the font once per process; pdfkit caches the parsed face. */
function pdfFont(doc) {
  if (cachedFont === undefined) {
    const file = resolveFontFile();
    cachedFont = file ? { family: "DocFont", file } : null;
    if (cachedFont) doc.registerFont(cachedFont.family, cachedFont.file);
  } else if (cachedFont) {
    doc.registerFont(cachedFont.family, cachedFont.file);
  }
  return cachedFont ? "DocFont" : "Helvetica";
}

/**
 * WinAnsi cannot encode most of the world's scripts. When no Unicode font is
 * available we degrade explicitly rather than letting pdfkit throw halfway
 * through writing a file.
 */
function toWinAnsi(text) {
  return String(text).replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/**
 * Load the bytes of an image that lives in our own storage.
 *
 * An external URL is deliberately not fetched: exporting would then depend on a
 * third party being reachable, and a document could exfiltrate itself. Those
 * images become a caption line instead.
 */
async function loadImage(attachmentId, resolveKey) {
  if (!attachmentId || !resolveKey) return null;
  try {
    const key = await resolveKey(attachmentId);
    return key ? await fsp.readFile(key) : null;
  } catch {
    return null;
  }
}

/** Natural size in pixels, used to scale into the page width. */
function displaySize(block, maxWidth) {
  const w = block.width || 640;
  const h = block.height || Math.round((w / 4) * 3);
  const ratio = h / w;
  const width = Math.min(w, maxWidth);
  return { width, height: width * ratio };
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

function docxRuns(runs, { size, italics = false, baseSize = 11 } = {}) {
  return runs.map((run) => {
    const opts = {
      text: run.text,
      // docx measures in half-points.
      size: Math.round((run.size || size || baseSize) * 2),
    };
    if (italics || run.italic) opts.italics = true;
    if (run.bold) opts.bold = true;
    if (run.strike) opts.strike = true;
    if (run.code) {
      opts.font = "Courier New";
      opts.shading = { type: ShadingType.CLEAR, fill: "F1F1F1" };
    }
    if (run.link) {
      // docx has no inline hyperlink run; an external relationship is the only
      // faithful way to express a clickable link.
      opts.style = "Hyperlink";
    }
    if (run.sup) { opts.superScript = true; }
    if (run.sub) { opts.subScript = true; }
    if (run.highlight) { opts.highlight = "yellow"; }
    if (run.color && /^#[0-9a-f]{6}$/i.test(run.color)) opts.color = run.color.slice(1);
    return new TextRun(opts);
  });
}

const HEADING_SIZES = { 1: 32, 2: 26, 3: 22, 4: 20, 5: 18, 6: 16 };

function docxBlock(block, ctx) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, block.level || 1));
      const headingLevel = HeadingLevel[`HEADING_${level}`];
      return new Paragraph({
        heading: headingLevel,
        spacing: { before: 240, after: 120 },
        children: docxRuns(block.runs, { size: HEADING_SIZES[level] }),
      });
    }
    case "quote":
      return new Paragraph({
        indent: { left: 720 },
        border: { left: { style: "single", size: 12, color: "D4D4D8" } },
        spacing: { before: 120, after: 120 },
        children: docxRuns(block.runs, { italics: true }),
      });
    case "code":
      return new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: "F6F6F6" },
        border: {
          top: { style: "single", size: 4, color: "E4E4E7" },
          bottom: { style: "single", size: 4, color: "E4E4E7" },
          left: { style: "single", size: 4, color: "E4E4E7" },
          right: { style: "single", size: 4, color: "E4E4E7" },
        },
        children: block.text.split("\n").map(
          (line) => new TextRun({ text: line || " ", font: "Courier New", size: 20 })
        ),
      });
    case "list": {
      // docx wants each item as its own paragraph with a numbering definition,
      // so one definition is emitted per list and referenced by number.
      const reference = ctx.nextList(block.ordered);
      return block.items.map(
        (item) =>
          new Paragraph({
            numbering: { reference, level: 0 },
            spacing: { after: 60 },
            children: docxRuns(item),
          })
      );
    }
    case "table":
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map(
          (r) =>
            new TableRow({
              children: r.cells.map(
                (c) =>
                  new TableCell({
                    shading: c.header ? { type: ShadingType.CLEAR, fill: "F4F4F5" } : undefined,
                    children: [new Paragraph({ children: docxRuns(c.runs, { bold: c.header }) })],
                  })
              ),
            })
        ),
      });
    case "hr":
      return new Paragraph({
        border: { bottom: { style: "single", size: 6, color: "D4D4D8" } },
        spacing: { before: 120, after: 120 },
        children: [new TextRun("")],
      });
    case "attachment":
      return new Paragraph({
        spacing: { before: 120, after: 120 },
        border: {
          top: { style: "single", size: 4, color: "E4E4E7" },
          bottom: { style: "single", size: 4, color: "E4E4E7" },
          left: { style: "single", size: 4, color: "E4E4E7" },
          right: { style: "single", size: 4, color: "E4E4E7" },
        },
        children: [
          new TextRun({ text: "📎 ", size: 22 }),
          new TextRun({ text: block.name || "Attachment", bold: true }),
          new TextRun({ text: block.bytes ? `  (${formatBytes(block.bytes)})` : "", color: "71717A" }),
        ],
      });
    case "pagebreak":
      return new Paragraph({ pageBreakBefore: true, children: [new TextRun("")] });
    case "image":
      return imageBlock(block, ctx);
    case "paragraph":
    default:
      return new Paragraph({ spacing: { after: 120 }, children: docxRuns(block.runs) });
  }
}

/**
 * An image is either embedded, or -- when the bytes are not available, which is
 * the case for a remote URL or a file whose storage lookup failed -- rendered as
 * its alt text. Dropping it silently would make an exported document look
 * complete while missing the one thing the reader came for.
 */
function imageBlock(block, ctx) {
  if (block.buffer) {
    const type = block.mime || "image/png";
    return new Paragraph({
      spacing: { before: 120, after: 120 },
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type,
          data: block.buffer,
          // Word needs a transformation; 300x200 is a sane default for a figure
          // when the editor did not record real pixel dimensions.
          transformation: imageTransformation(block),
        }),
      ],
    });
  }

  const caption = block.alt || "Image";
  const suffix = block.src ? `  (${block.src})` : "";
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: {
      top: { style: "single", size: 4, color: "E4E4E7" },
      bottom: { style: "single", size: 4, color: "E4E4E7" },
      left: { style: "single", size: 4, color: "E4E4E7" },
      right: { style: "single", size: 4, color: "E4E4E7" },
    },
    children: [
      new TextRun({ text: `[Image: ${caption}]`, italic: true, color: "71717A" }),
      ...(suffix ? [new TextRun({ text: suffix, size: 16, color: "A1A1AA" })] : []),
    ],
  });
}

/** DOCX dimensions are in pixels at 96dpi, clamped to Word's 55 inch limit. */
function imageTransformation(block) {
  const maxWidth = 560;
  const width = block.width || maxWidth;
  const height = block.height || Math.round((width * 2) / 3);
  const shrink = width > maxWidth ? maxWidth / width : 1;
  return {
    width: Math.max(1, Math.round(width * shrink)),
    height: Math.max(1, Math.round(height * shrink)),
  };
}

/** Build a fresh numbering counter, one per list, so numbering restarts. */
function listCounter() {
  let n = 0;
  return {
    nextList(ordered) {
      n += 1;
      return { ordered, id: n };
    },
    get count() {
      return n;
    },
  };
}

/**
 * Render blocks to a .docx buffer.
 *
 * @param {Array} blocks from `htmlToBlocks`
 * @param {object} [options]
 * @param {string} [options.title] document title, used as the file name and H1
 * @param {number} [options.pageBreakBeforeHeading1] put the body on page two
 */
export async function renderDocx(blocks, options = {}) {
  const { title = "Document", includeTitle = true } = options;

  const children = [];
  if (includeTitle && title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 240 },
        children: [new TextRun({ text: title, bold: true })],
      })
    );
  }

  const counter = listCounter();
  // docx numbering definitions are document-level, so they are collected first
  // and handed to the constructor with everything else.
  const definitions = [];
  const body = [];
  for (const block of blocks) {
    const rendered = docxBlock(block, { nextList: (ordered) => {
      const ref = counter.nextList(ordered);
      definitions.push(ref);
      return ref.id;
    } });
    for (const node of [].concat(rendered)) body.push(node);
  }

  const numbering = definitions.map((def) => ({
    reference: String(def.id),
    levels: [
      {
        level: 0,
        format: def.ordered ? "decimal" : "bullet",
        text: def.ordered ? "%1." : "•",
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      },
    ],
  }));

  const doc = new Document({
    creator: "Collaborative Document Editor",
    title,
    sections: [
      {
        children: [...children, ...body],
      },
    ],
    numbering: numbering.length ? { config: numbering } : undefined,
  });

  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/**
 * Render blocks to a PDF buffer.
 *
 * pdfkit is a stream API, so the document is written into a collecting stream
 * and the finished bytes are returned. Streaming also means a large document
 * never has to exist in memory twice.
 */
export async function renderPdf(blocks, options = {}) {
  const { title = "Document", includeTitle = true, pageSize = "A4" } = options;

  const doc = new PDFDocument({
    size: pageSize,
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    info: { Title: title, Creator: "Collaborative Document Editor" },
    autoFirstPage: true,
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const family = pdfFont(doc);
  const unicode = family !== "Helvetica";
  // Everything below is laid out against this column, and indentation is applied
  // by moving the cursor rather than by wrapping text in spaces.
  const MARGIN = doc.page.margins.left;
  const RIGHT = doc.page.width - doc.page.margins.right;
  const contentWidth = RIGHT - MARGIN;

  const clean = (text) => (unicode ? text : toWinAnsi(text));

  /**
   * Write one paragraph's runs.
   *
   * pdfkit's `continued` mode is the whole trick: each run is written with
   * `continued: true` so the next one starts on the same line, and the final run
   * closes it. Wrapping, line height and page breaks are then pdfkit's problem
   * rather than this file's.
   */
  const writeRuns = (runs, { size = 11, indent = 0, color = "#18181b" } = {}) => {
    if (!runs.length) return;
    const width = contentWidth - indent;
    doc.x = MARGIN + indent;

    runs.forEach((run, index) => {
      const last = index === runs.length - 1;
      const size_ = (run.size || size) * (run.sup || run.sub ? 0.72 : 1);
      if (run.highlight) doc.fillColor("#FEF3C7");
      doc
        .font(run.code ? "Courier" : family)
        .fontSize(size_)
        .fillColor(run.color || color);
      doc.text(clean(run.text ?? ""), {
        width,
        continued: !last,
        link: run.link || undefined,
        underline: run.underline || undefined,
        strike: run.strike || undefined,
        // A run that is only a superscript sits on the previous line, which is
        // what makes `x^2` read as an exponent rather than as a new row.
        ...(run.sup ? { baseline: "superscript" } : {}),
        ...(run.sub ? { baseline: "subscript" } : {}),
      });
    });

    // End the paragraph on the left edge again.
    doc.x = MARGIN;
  };

  if (includeTitle && title) {
    doc.font(family).fontSize(22).fillColor("#09090b");
    doc.text(clean(title), { width: contentWidth });
    doc.moveDown(0.6);
    doc.moveTo(MARGIN, doc.y).lineTo(RIGHT, doc.y).strokeColor("#e4e4e7").stroke();
    doc.moveDown(0.8);
  }

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const size = { 1: 20, 2: 17, 3: 15, 4: 13, 5: 12, 6: 11 }[block.level] || 12;
        doc.moveDown(0.4);
        writeRuns(block.runs.map((r) => ({ ...r, bold: true })), { size, color: "#09090b" });
        doc.moveDown(0.2);
        break;
      }
      case "quote": {
        const top = doc.y;
        writeRuns(block.runs, { indent: 24 });
        // The rule is drawn last, over the height the text actually took.
        doc
          .moveTo(MARGIN + 8, top - 2)
          .lineTo(MARGIN + 8, doc.y + 2)
          .strokeColor("#d4d4d8")
          .stroke();
        doc.moveDown(0.3);
        break;
      }
      case "code":
        doc.moveDown(0.2);
        writeRuns([{ text: block.text || " ", code: true }], { size: 9, color: "#3f3f46" });
        doc.moveDown(0.4);
        break;
      case "list": {
        let n = 1;
        for (const item of block.items) {
          const marker = block.ordered ? `${n}.` : "\u2022";
          const top = doc.y;
          doc.font(family).fontSize(11).fillColor("#3f3f46");
          doc.text(clean(marker), MARGIN + 14, top, { width: 24, lineBreak: false });
          writeRuns(item, { indent: 40 });
          n += 1;
        }
        doc.moveDown(0.3);
        break;
      }
      case "table":
        drawTable(doc, block, { family, clean, contentWidth, MARGIN, RIGHT });
        doc.moveDown(0.5);
        break;
      case "hr":
        doc.moveDown(0.3);
        doc.moveTo(MARGIN, doc.y).lineTo(RIGHT, doc.y).strokeColor("#e4e4e7").stroke();
        doc.moveDown(0.5);
        break;
      case "pagebreak":
        doc.addPage();
        doc.y = doc.page.margins.top;
        break;
      case "attachment": {
        const top = doc.y;
        const height = 26;
        doc.roundedRect(MARGIN, top, contentWidth, height, 5).fillAndStroke("#fafafa", "#e4e4e7");
        doc
          .font(family)
          .fontSize(11)
          .fillColor("#18181b")
          .text(clean(`\u{1F4CE} ${block.name || "Attachment"}`), MARGIN + 10, top + 8, {
            width: contentWidth - 90,
            lineBreak: false,
          });
        if (block.bytes) {
          doc
            .font(family)
            .fontSize(9)
            .fillColor("#71717a")
            .text(formatBytes(block.bytes), RIGHT - 74, top + 9, { width: 64, align: "right", lineBreak: false });
        }
        doc.x = MARGIN;
        doc.y = top + height + 8;
        break;
      }
      case "image": {
        // Bytes are resolved before rendering, so this renderer does no IO.
        if (block.buffer) {
          const { width, height } = displaySize(block, contentWidth);
          if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            doc.y = doc.page.margins.top;
          }
          try {
            doc.image(block.buffer, MARGIN, doc.y, { width, height });
          } catch {
            doc
              .font(family)
              .fontSize(10)
              .fillColor("#71717a")
              .text(clean(`[image: ${block.alt || "attachment"}]`));
          }
          doc.x = MARGIN;
          doc.y += height + 10;
        } else {
          doc
            .font(family)
            .fontSize(10)
            .fillColor("#71717a")
            .text(clean(`[image: ${block.alt || block.src || "attachment"}]`));
          doc.moveDown(0.3);
        }
        break;
      }
      case "paragraph":
      default:
        if (block.runs.length) writeRuns(block.runs, { size: 11 });
        doc.moveDown(0.35);
        break;
    }
  }

  doc.end();
  return finished;
}

/** A simple grid: fixed column widths, borders, header row shaded. */
function drawTable(doc, block, opts) {
  const { family, clean, contentWidth, MARGIN, RIGHT } = opts;
  const columns = Math.max(1, ...block.rows.map((r) => r.cells.length));
  const colWidth = contentWidth / columns;
  const fontSize = 10;

  for (const r of block.rows) {
    const joined = r.cells.map((c) => c.runs.map((run) => run.text).join("")).join(" ");
    const rowHeight =
      Math.max(
        18,
        doc.font(family).fontSize(fontSize).heightOfString(clean(joined || " "), { width: colWidth - 8 })
      ) + 8;
    const top = doc.y;
    if (top + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      continue; // re-enter on the next page; the row is drawn below
    }

    r.cells.forEach((c, index) => {
      const x = MARGIN + index * colWidth;
      if (c.header) doc.rect(x, doc.y, colWidth, rowHeight).fill("#f4f4f5");
      doc.rect(x, doc.y, colWidth, rowHeight).strokeColor("#e4e4e7").stroke();
      doc
        .font(family)
        .fontSize(fontSize)
        .fillColor("#18181b")
        .text(clean(c.runs.map((run) => run.text).join("")), x + 4, doc.y + 4, {
          width: colWidth - 8,
        });
    });

    // `text` leaves the cursor inside the last cell, so restore the row baseline.
    doc.x = MARGIN;
    doc.y = top + rowHeight;
  }
  void RIGHT;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export { loadImage, resolveFontFile };
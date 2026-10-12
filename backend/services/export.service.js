import { htmlToPlainText } from "../utils/text.js";
import { htmlToBlocks, loadImage, renderDocx, renderPdf } from "./export.office.js";

// `htmlToMarkdown` is exported by its own declaration further down.
export { htmlToBlocks };

function decode(str) {
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function inlineMarkdown(str) {
  let s = String(str || "");
  s = s.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
  s = s.replace(/<b>(.*?)<\/b>/gi, "**$1**");
  s = s.replace(/<em>(.*?)<\/em>/gi, "*$1*");
  s = s.replace(/<i>(.*?)<\/i>/gi, "*$1*");
  s = s.replace(/<del>(.*?)<\/del>/gi, "~~$1~~");
  s = s.replace(/<code>(.*?)<\/code>/gi, "`$1`");
  s = s.replace(
    /<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi,
    "[$2]($1)"
  );
  s = s.replace(/<sup>(.*?)<\/sup>/gi, "^($1)");
  s = s.replace(/<sub>(.*?)<\/sub>/gi, "~($1)");
  return decode(s);
}

export function htmlToMarkdown(html = "") {
  let s = String(html || "");

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<li>(.*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<blockquote>(.*?)<\/blockquote>/gi, (m, inner) =>
    `\n> ${inner.replace(/\n/g, "\n> ")}\n`
  );
  s = s.replace(
    /<pre>(.*?)<\/pre>/gi,
    (m, inner) => `\n\`\`\`\n${decode(inner.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`
  );
  s = s.replace(
    /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
    (m, level, inner) => `\n\n${"#".repeat(Number(level))} ${inlineMarkdown(inner)}\n\n`
  );

  const lines = s.split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      inList = false;
      out.push("");
    } else if (/^- /.test(trimmed)) {
      out.push(trimmed);
      inList = true;
    } else {
      if (inList) out.push("");
      inList = false;
      out.push(line.replace(/<[^>]+>/g, "").trim());
    }
  }

  return out
    .map(inlineMarkdown)
    .join("\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

export const buildExport = (doc, format) => {
  switch (format) {
    case "markdown":
      return { content: htmlToMarkdown(doc.content), ext: "md", type: "text/markdown; charset=utf-8" };
    case "txt":
      return { content: doc.plainText || htmlToPlainText(doc.content), ext: "txt", type: "text/plain; charset=utf-8" };
    case "html":
      return { content: doc.content, ext: "html", type: "text/html; charset=utf-8" };
    default:
      return { content: doc.content, ext: "html", type: "text/html; charset=utf-8" };
  }
};

/**
 * Export to a real office format (master plan section 28: PDF and DOCX).
 *
 * Separate from `buildExport` because these are binary and asynchronous, and
 * because images have to be read out of storage before the bytes are embedded --
 * the renderer itself never does IO.
 *
 * @param {object} doc          the document record
 * @param {'pdf'|'docx'} format
 * @param {object} [options]
 * @param {(attachmentId: string) => Promise<string|null>} [options.resolveStorageKey]
 *        maps an attachment id to its storage key, so an image can be embedded
 */
export async function buildBinaryExport(doc, format, options = {}) {
  const blocks = htmlToBlocks(doc.content);
  const { resolveStorageKey = null } = options;

  // Embed our own stored images; leave third-party URLs as captions.
  for (const block of blocks) {
    if (block.type !== "image") continue;
    const bytes = await loadImage(block.attachmentId, resolveStorageKey).catch(() => null);
    if (bytes) {
      block.buffer = bytes;
      // Word infers the format from the declared type, and the content URL says
      // what the stored file actually is.
      if (!block.mime && /\.(png|jpe?g|gif|bmp|webp)(\?|$)/i.test(block.src || "")) {
        const guess = (block.src.match(/\.([a-z0-9]+)/i) || [])[1];
        block.mime = `image/${guess.toLowerCase() === "jpg" ? "jpeg" : guess.toLowerCase()}`;
      }
    }
  }

  const title = doc.title || "Document";

  if (format === "docx") {
    const content = await renderDocx(blocks, { title });
    return {
      content,
      ext: "docx",
      // The OOXML content type, not a generic binary type: Word refuses to open
      // a .docx served as application/octet-stream in some configurations.
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }

  const content = await renderPdf(blocks, { title });
  return { content, ext: "pdf", type: "application/pdf" };
}
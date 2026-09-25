import { htmlToPlainText } from "../utils/text.js";

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
    default:
      return { content: doc.content, ext: "html", type: "text/html; charset=utf-8" };
  }
};
const BLOCK_TAGS =
  /<\/?((br|div|p|h[1-6]|li|blockquote|pre|table|thead|tbody|tr|td|th)[^>]*)>/gi;
const ALL_TAGS = /<[^>]+>/g;

export function decodeEntities(str) {
  const map = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  };
  return str.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => map[m] || m);
}

export function htmlToPlainText(html = "") {
  return decodeEntities(
    (html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|h[1-6]|li|blockquote|pre|tr|table)>/gi, "\n")
      .replace(ALL_TAGS, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
  ).trim();
}

export function tiptapJsonToPlainText(json = null) {
  if (!json || !Array.isArray(json.content)) return "";
  const parts = [];

  const walk = (node) => {
    if (!node) return;
    const text = node.text ?? "";
    if (text) parts.push(text);
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      if (node.type && /^(paragraph|heading|listItem|blockquote|codeBlock|tableRow)$/.test(node.type)) {
        parts.push("\n");
      }
    }
  };

  json.content.forEach(walk);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainTextOf(doc) {
  if (doc.contentJson) {
    const t = tiptapJsonToPlainText(doc.contentJson);
    if (t) return t;
  }
  return htmlToPlainText(doc.content);
}
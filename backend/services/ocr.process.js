/**
 * Post-processing for OCR output: language detection, formatting cleanup and
 * block-structure recognition.
 *
 * Provider accuracy varies, so the raw text is always cleaned here before it
 * reaches the document. Kept as pure functions so they are easy to test.
 */

// Urdu/Arabic script ranges (Arabic block plus the Urdu-specific letters).
const URDU_CHARS = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
// Devanagari (Hindi) script.
const DEVANAGARI_CHARS = /[\u0900-\u097F]/;

/**
 * Detect the dominant language from a Unicode script perspective.
 *
 * Script tells Urdu/Arabic apart confidently. For Latin script we use a small
 * Roman-Urdu marker set, since Roman Urdu is written with English letters.
 *
 * @param {string} text
 * @returns {{code: string, confidence: number}}
 */
export function detectLanguage(text = "") {
  const value = String(text);
  if (!value.trim()) return { code: "unknown", confidence: 0 };

  const letters = value.replace(/[^A-Za-z\u0600-\u06FF\u0900-\u097F]/g, "");
  if (!letters) return { code: "unknown", confidence: 0 };

  const urdu = (value.match(URDU_CHARS) || []).length;
  const deva = (value.match(DEVANAGARI_CHARS) || []).length;
  const total = letters.length || 1;

  if (deva / total > 0.3) return { code: "hi", confidence: Math.round((deva / total) * 100) };
  if (urdu / total > 0.3) {
    // Distinguish Urdu from Modern Standard Arabic with the nastaliq-only
    // letters that Arabic text rarely uses.
    const urduOnly = (value.match(/[ٹپچڈڈڑںھےہ]/g) || []).length;
    return { code: urduOnly > 0 ? "ur" : "ar", confidence: Math.round((urdu / total) * 100) };
  }

  // Latin script: Roman Urdu markers.
  const romanUrdu = (value.match(/\b(hai|hain|kya|koi|nahi|nahi|ka|ki|ke|ko|mein|main|aap|hum|wo|ye|bohot|bahut|acha|theek|kar|karte|karna)\b/gi) || [])
    .length;
  if (romanUrdu >= 2) return { code: "roman-ur", confidence: 60 };

  return { code: "en", confidence: 70 };
}

/**
 * Clean OCR noise without changing the author's words.
 *
 * - Collapses runs of spaces/tabs.
 * - Normalises whitespace-only lines away.
 * - Fixes a space that OCR often inserts before punctuation.
 * - Collapses 3+ blank lines into one blank line.
 */
export function cleanOcrText(text = "") {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // Common OCR artefacts: "word ," -> "word," and stray space after punctuation.
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/\n{2,}$/g, "")
    .trim();
}

/** Classify a single line into a block type. */
function classifyLine(line) {
  const t = line.trim();
  if (!t) return "empty";
  // Markdown-style heading that the provider may have emitted.
  if (/^#{1,6}\s+/.test(t)) return "heading";
  // Short, title-ish line: a numbered section like "3. Terms".
  if (/^\d+[.)]\s+[A-Z][^.!?]{0,60}$/.test(t)) return "heading";
  // List markers.
  if (/^([-*•‣▪·o]\s+|\d+[.)]\s+)/.test(t)) return "list";
  // Signature-style closing.
  if (/^(sincerely|regards|best regards|shukriya|با احترام|सादर)\b/i.test(t)) return "signature";
  return "paragraph";
}

/**
 * Turn cleaned text into typed blocks, so the UI can offer structure-aware
 * insertion (headings, lists, paragraphs) rather than one flat blob.
 *
 * @param {string} text
 * @returns {Array<{type: string, text: string}>}
 */
export function toBlocks(text = "") {
  const blocks = [];
  const lines = String(text).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const type = classifyLine(line);
    if (type === "empty") continue;

    if (type === "heading") {
      blocks.push({ type: "heading", text: line.replace(/^#{1,6}\s+/, "").trim() });
      continue;
    }

    // Join a bullet's wrapped continuation lines onto the bullet line.
    if (type === "list") {
      let buf = line;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        const nextType = classifyLine(next);
        if (nextType === "empty") break;
        if (nextType === "list" || nextType === "heading") break;
        buf += ` ${next.trim()}`;
        j++;
      }
      blocks.push({ type: "list", text: buf.trim() });
      i = j - 1;
      continue;
    }

    blocks.push({ type, text: line.trim() });
  }

  return blocks;
}

/**
 * Heuristically spot an invoice/receipt and pull key fields out of it.
 * Returns null when the text does not look like an invoice.
 */
export function detectInvoiceFields(text = "") {
  const t = String(text);
  const hasInvoiceWord = /invoice|receipt|bill|tax invoice|challan/i.test(t);
  if (!hasInvoiceWord) return null;

  const grab = (patterns) => {
    for (const p of patterns) {
      const m = t.match(p);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  };

  return {
    vendor: grab([
      /^(?:from|vendor|seller|supplier)\s*[:\-]\s*(.+)$/im,
      /^(.+?)\s+(?:invoice|bill)\s*(?:no|number|#)?/im,
    ]),
    invoiceNumber: grab([
      /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\-/]+)/i,
      /^invoice\s*#\s*([A-Za-z0-9\-/]+)/im,
    ]),
    date: grab([/\bdate\s*[:\-]\s*(.+)$/im, /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/]),
    subtotal: grab([/\bsub\s?total\s*[:\-]?\s*([\d.,]+)/i]),
    tax: grab([/\b(?:tax|vat|gst)\s*[:\-]?\s*([\d.,]+)/i]),
    total: grab([
      /\bgrand\s*total\s*[:\-]?\s*([\d.,]+)/i,
      /\btotal\s*[:\-]?\s*([\d.,]+)/i,
    ]),
  };
}

/**
 * Merging several OCR passes over the same image.
 *
 * A single Tesseract model can only read one script well. A page that mixes
 * English and Urdu defeats both an English-only and an Urdu-only pass: the
 * English pass turns the Urdu into Latin gibberish, the Urdu pass turns the
 * English into Arabic gibberish.
 *
 * The fix is to run one pass per script family and keep, for each line of the
 * page, the version the engine was most confident about. Tesseract reports a
 * confidence per line, and that number is a reliable signal: on a mixed page
 * the English heading scores ~94 in the English pass and ~64 in the Urdu pass,
 * while the Urdu line scores ~15 in the English pass and ~74 in the Urdu pass.
 *
 * Everything here is a pure function so it can be reasoned about (and tested)
 * without running a real OCR engine.
 */

/** Arabic letters (digits are left out, they are not evidence of a script). */
const ARABIC = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
/** Devanagari letters. */
const DEVANAGARI = /[\u0904-\u0939\u093D\u0950-\u095F\u0979-\u097F]/g;
/** Latin letters. */
const LATIN = /[A-Za-z]/g;

/** Count how many letters of each script a piece of text contains. */
export function countScripts(text = "") {
  const value = String(text);
  return {
    arabic: (value.match(ARABIC) || []).length,
    devanagari: (value.match(DEVANAGARI) || []).length,
    latin: (value.match(LATIN) || []).length,
  };
}

/** How many real letters a line holds, whatever the script. */
export function letterCount(text = "") {
  const counts = countScripts(text);
  return counts.arabic + counts.devanagari + counts.latin;
}

/** Vertical overlap between two boxes, as a fraction of the shorter one. */
function verticalOverlap(a, b) {
  const top = Math.max(a.bbox.y0, b.bbox.y0);
  const bottom = Math.min(a.bbox.y1, b.bbox.y1);
  if (bottom <= top) return 0;
  const overlap = bottom - top;
  const shortest = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0) || 1;
  return overlap / shortest;
}

/** Group lines that sit on the same visual row, whatever pass produced them. */
function groupRows(lines) {
  const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rows = [];
  for (const line of sorted) {
    const row = rows.find((r) => r.some((other) => verticalOverlap(other, line) > 0.5));
    if (row) row.push(line);
    else rows.push([line]);
  }
  return rows;
}

/** Average confidence of a set of lines (0 when there are none). */
export function averageConfidence(lines = []) {
  if (!lines.length) return 0;
  const total = lines.reduce((sum, l) => sum + (l.confidence || 0), 0);
  return total / lines.length;
}

/**
 * Flatten Tesseract's block/paragraph/line tree into plain lines.
 *
 * @param {Array} blocks `data.blocks` from a tesseract.js result
 * @returns {Array<{text: string, confidence: number, bbox: object}>}
 */
export function extractLines(blocks = []) {
  const lines = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = (line.text || "").replace(/\n+$/, "");
        if (!text.trim()) continue;
        lines.push({ text, confidence: line.confidence || 0, bbox: line.bbox });
      }
    }
  }
  return lines;
}

/**
 * Turn a list of chosen lines back into text, in reading order.
 *
 * A gap that is clearly larger than the usual line height was a paragraph
 * break, so it is kept as a blank line.
 *
 * @param {Array<{text: string, bbox: object}>} lines
 * @returns {string}
 */
export function formatLines(lines = []) {
  const ordered = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const heights = ordered.map((l) => l.bbox.y1 - l.bbox.y0).filter((h) => h > 0);
  const typical = heights.length ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 0;

  let text = "";
  let previous = null;
  for (const line of ordered) {
    if (previous) {
      const gap = line.bbox.y0 - previous.bbox.y1;
      if (typical && gap > typical * 1.6) text += "\n";
    }
    text += (text ? "\n" : "") + line.text;
    previous = line;
  }
  return text;
}

/**
 * Merge the lines of several passes, keeping the most confident version of
 * each row and restoring the page order.
 *
 * @param {Array<Array>} passes one array of lines per pass
 * @returns {{text: string, confidence: number, lines: Array}}
 */
export function mergePasses(passes = []) {
  const all = passes.flat();
  if (!all.length) return { text: "", confidence: 0, lines: [] };

  const rows = groupRows(all);
  const chosen = rows.map((row) =>
    row.reduce((best, line) => {
      if (line.confidence > best.confidence + 0.5) return line;
      if (best.confidence > line.confidence + 0.5) return best;
      // A tie is broken by the amount of real text: the wrong model tends to
      // answer with digits and punctuation rather than letters.
      return letterCount(line.text) > letterCount(best.text) ? line : best;
    })
  );

  return { text: formatLines(chosen), confidence: averageConfidence(chosen), lines: chosen };
}

/**
 * Is a result good enough to stop looking for a better one?
 *
 * A page is settled when the engine is confident about every line. A single
 * low-confidence line usually means "this line is in another script", which is
 * exactly the case another pass can fix.
 */
export function isSettled(result) {
  if (!result || !result.lines.length) return false;
  return result.confidence >= 60 && result.lines.every((l) => l.confidence >= 45);
}

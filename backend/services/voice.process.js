import { VOICE_COMMANDS } from "../config/voice.js";

/**
 * Post-processing for raw speech transcripts.
 *
 * Speech-to-text engines return an unpunctuated run of words. This module turns
 * that into something a person would have written, and recognises spoken editing
 * commands. Everything here is pure so it can be tested without a provider.
 *
 * Design note (master plan section 18): cleanup is deliberately conservative.
 * It adds punctuation and paragraph breaks but never rewrites vocabulary, and
 * the caller always keeps the raw transcript so the user can verify it.
 */

// The `g` flag matters: `String.match` with a non-global regex reports a single
// hit, which made non-Latin scripts always look like a tiny minority.
const URDU_CHARS = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const DEVANAGARI_CHARS = /[\u0900-\u097F]/g;

/** Words that almost always end a sentence when they appear mid-stream. */
const SENTENCE_STARTERS = new Set([
  "so",
  "then",
  "next",
  "now",
  "after",
  "finally",
  "also",
  "but",
  "because",
  "however",
  "and",
  "ok",
  "okay",
  "right",
  "well",
  "anyway",
]);

/** Connectors that read as a new paragraph when the speaker pauses around them. */
const PARAGRAPH_STARTERS = new Set([
  "first",
  "second",
  "third",
  "finally",
  "in conclusion",
  "to summarize",
  "in summary",
  "moving on",
  "next up",
  "on the other hand",
  "meanwhile",
]);

/** Trailing fillers to strip when they end an utterance. */
const TRAILING_FILLERS = /\b(um+|uh+|erm+|hmm+|you know|i mean)\s*$/i;

/**
 * Detect the dominant language of a transcript.
 *
 * @param {string} text
 * @returns {{code: string, confidence: number}}
 */
export function detectLanguage(text = "") {
  const value = String(text);
  if (!value.trim()) return { code: "unknown", confidence: 0 };

  const letters = value.replace(/[^A-Za-z\u0600-\u06FF\u0900-\u097F]/g, "");
  if (!letters) return { code: "unknown", confidence: 0 };

  const total = letters.length;
  const deva = (value.match(DEVANAGARI_CHARS) || []).length;
  const arabic = (value.match(URDU_CHARS) || []).length;

  if (deva / total > 0.3) return { code: "hi", confidence: Math.round((deva / total) * 100) };
  if (arabic / total > 0.3) {
    // Urdu-only letters separate Urdu from Modern Standard Arabic.
    const urduOnly = (value.match(/[ٹپچڈڈڑںھےہ]/g) || []).length;
    return { code: urduOnly > 0 ? "ur" : "ar", confidence: Math.round((arabic / total) * 100) };
  }

  const romanUrdu = (
    value.match(/\b(hai|hain|kya|koi|nahi|ka|ki|ke|ko|mein|main|aap|hum|wo|ye|bohot|bahut|acha|theek)\b/gi) || []
  ).length;
  if (romanUrdu >= 2) return { code: "roman-ur", confidence: 55 };

  return { code: "en", confidence: 75 };
}

/** Capitalise the first letter without disturbing the rest of the word. */
function capitalize(word) {
  if (!word) return word;
  // Leave scripts without a case distinction untouched.
  if (!/[a-z]/i.test(word)) return word;
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Insert sentence punctuation.
 *
 * Rules, in order of confidence:
 *   1. Existing punctuation is respected, never doubled.
 *   2. A connector that starts a clause ("so we shipped") gets a comma before it.
 *   3. A connector after a long stretch of words ends the sentence.
 *   4. A capitalised word mid-sentence, or a long run, ends the sentence.
 *   5. The end of the transcript always gets a full stop.
 *
 * @param {string} text
 * @returns {string}
 */
export function addPunctuation(text = "") {
  const raw = String(text).replace(/\s+/g, " ").trim();
  if (!raw) return "";

  // Split on existing sentence terminators so each chunk is processed alone.
  const chunks = raw.split(/(?<=[.!?؟。])\s+/);
  const out = [];

  chunks.forEach((chunk, chunkIndex) => {
    const words = chunk.split(" ").filter(Boolean);
    if (!words.length) return;
    const isLast = chunkIndex === chunks.length - 1;
    const alreadyPuncted = /[.!?؟。]$/.test(chunk);
    if (alreadyPuncted && !isLast) {
      // Still capitalise: speech gives no casing, and this chunk opens a sentence.
      out.push(capitalize(chunk));
      return;
    }

    const built = [];
    words.forEach((word, i) => {
      const bare = word.replace(/[.,!?;:]$/, "").toLowerCase();
      const isFirst = i === 0;
      const prev = built[built.length - 1] || "";

      if (isFirst) {
        // Every chunk opens a sentence, so it always starts with a capital.
        built.push(capitalize(word));
        return;
      }

      // Only the first connector in a chain earns a comma: "so the team was
      // happy, and then we ate" must not become "happy, and, then".
      const isConnector = SENTENCE_STARTERS.has(bare);
      const prevBare = prev.replace(/[.,!?;:]$/, "").toLowerCase();
      const prevWasConnector = SENTENCE_STARTERS.has(prevBare) && !/[.!?]$/.test(prev);
      const prevEndsClause = /[,;:]$/.test(prev);

      if (isConnector && i > 3 && !prevEndsClause && !prevWasConnector) {
        built[built.length - 1] = `${prev},`;
        built.push(word);
        return;
      }

      // A connector that follows a long stretch ends the previous sentence.
      if (isConnector && built.length >= 14 && !prevEndsClause && !prevWasConnector) {
        built[built.length - 1] = `${prev}.`;
        built.push(capitalize(word));
        return;
      }

      // A capitalised word partway through a long sentence is a new sentence.
      if (
        !isFirst &&
        built.length >= 8 &&
        /^[A-Z]/.test(word) &&
        !SENTENCE_STARTERS.has(prevBare) &&
        !/[.!?]$/.test(prev)
      ) {
        built[built.length - 1] = `${prev}.`;
        built.push(word);
        return;
      }

      built.push(word);
    });

    let sentence = built.join(" ").replace(TRAILING_FILLERS, "").trim();
    if (sentence && !/[.!?؟。]$/.test(sentence)) sentence += isLast ? "." : ".";
    out.push(sentence);
  });

  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Split a punctuated transcript into paragraphs.
 *
 * A blank line is inserted at explicit spoken transitions ("moving on",
 * "in summary") and at sentence boundaries that follow a long enough stretch,
 * so a rambling dictation becomes readable prose.
 *
 * @param {string} text
 * @returns {string}
 */
export function splitParagraphs(text = "") {
  const value = String(text).trim();
  if (!value) return "";

  const sentences = value.split(/(?<=[.!?؟。])\s+/).filter(Boolean);
  const paragraphs = [];
  let current = [];
  let wordCount = 0;

  const flush = () => {
    if (current.length) {
      paragraphs.push(current.join(" "));
      current = [];
      wordCount = 0;
    }
  };

  sentences.forEach((sentence) => {
    const words = sentence.split(" ").length;
    const lower = sentence.toLowerCase();

    const startsParagraph = [...PARAGRAPH_STARTERS].some((p) =>
      p.includes(" ") ? lower.startsWith(p) : lower.startsWith(`${p} `)
    );

    if (current.length && (startsParagraph || wordCount >= 90)) flush();

    current.push(sentence);
    wordCount += words;
  });

  flush();
  return paragraphs.join("\n\n");
}

/**
 * Detect and strip spoken editing commands from a transcript.
 *
 * The command is normally the last thing the speaker says ("... and that's it,
 * make this a heading"), so the scan runs from the end. Matching phrases are
 * removed and returned separately for the editor to act on.
 *
 * @param {string} text
 * @returns {{text: string, commands: Array<{id: string, phrase: string}>, matched: boolean}}
 */
export function extractCommands(text = "") {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const commands = [];
  if (!words.length) return { text: "", commands, matched: false };

  const strip = (word) => word.toLowerCase().replace(/[.,!?;:]/g, "");

  // Longest phrases first, so the full instruction "make this a heading" wins
  // over the bare "heading" nested inside it.
  const PHRASES = VOICE_COMMANDS.flatMap((command) =>
    command.phrases.map((phrase) => ({ id: command.id, phrase, words: phrase.split(" ") }))
  ).sort((a, b) => b.words.length - a.words.length);

  // Commands are spoken last, so a phrase only counts when it matches the tail
  // of the transcript. Anchoring at the tail also stops a stray content word
  // from being read as an instruction mid-sentence.
  while (words.length) {
    const end = words.length;
    const hit = PHRASES.find(
      (candidate) =>
        candidate.words.length <= end &&
        candidate.words.every((p, k) => strip(words[end - candidate.words.length + k]) === p)
    );
    if (!hit) break;

    commands.unshift({ id: hit.id, phrase: hit.phrase });
    words.splice(end - hit.words.length, hit.words.length);
  }

  return {
    text: words.join(" ").trim(),
    commands,
    matched: commands.length > 0,
  };
}

/**
 * Full server-side cleanup pipeline: commands out, punctuation in, paragraphs split.
 *
 * @param {string} rawTranscript
 * @returns {{text: string, commands: Array<{id: string, phrase: string}>, language: {code: string, confidence: number}}}
 */
export function processTranscript(rawTranscript = "") {
  const { text: withoutCommands, commands } = extractCommands(rawTranscript);
  const language = detectLanguage(withoutCommands || rawTranscript);
  const punctuated = addPunctuation(withoutCommands);
  return { text: splitParagraphs(punctuated), commands, language };
}

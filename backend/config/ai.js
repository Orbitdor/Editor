/**
 * AI / OCR provider configuration.
 *
 * Everything is read from the environment and resolved lazily, so the API can
 * boot without any keys and report "not configured" instead of crashing. That
 * keeps local development possible on machines with no provider account.
 */

/** Read a value from several possible env var names. */
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
};

export const SUPPORTED_LANGUAGES = ["auto", "en", "ur", "ar", "hi"];

export const LANGUAGES = {
  auto: "auto-detect",
  en: "English",
  ur: "Urdu",
  ar: "Arabic",
  hi: "Hindi",
};

/**
 * Writing-assistant actions the UI can trigger. Each one maps to a system
 * instruction in `ai.service.js`.
 */
export const AI_ACTIONS = [
  "improve",
  "fix-grammar",
  "rewrite",
  "professional",
  "concise",
  "expand",
  "summarize",
  "translate",
  "continue",
  "tone",
  "explain",
  "extract-tasks",
  "key-points",
];

/** Actions that operate on the whole document instead of a text selection. */
export const DOCUMENT_ACTIONS = new Set([
  "summarize",
  "key-points",
  "extract-tasks",
  "explain",
]);

/** Tones accepted by the `tone` action. */
export const AI_TONES = [
  "formal",
  "friendly",
  "confident",
  "concise",
  "persuasive",
  "professional",
  "empathetic",
  "technical",
];

/**
 * Provider settings, resolved on each call so tests and local tooling can
 * override env vars at runtime.
 */
export function aiConfig() {
  return {
    provider: (pick("AI_PROVIDER") || "openai").toLowerCase(),
    apiKey: pick("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_API_KEY"),
    baseUrl: pick("AI_BASE_URL", "OPENAI_BASE_URL") || "https://api.openai.com/v1",
    chatModel: pick("AI_CHAT_MODEL", "OPENAI_CHAT_MODEL") || "gpt-4o-mini",
    visionModel: pick("AI_VISION_MODEL", "OPENAI_VISION_MODEL") || "gpt-4o-mini",
    // Lets tests and local development exercise the whole pipeline offline.
    allowMock: (pick("AI_ALLOW_MOCK") || "true").toLowerCase() !== "false",
    // Safety limits so a single request cannot burn an unbounded budget.
    maxInputChars: Number(pick("AI_MAX_INPUT_CHARS")) || 12000,
    maxOutputTokens: Number(pick("AI_MAX_OUTPUT_TOKENS")) || 2000,
    timeoutMs: Number(pick("AI_TIMEOUT_MS")) || 45000,
  };
}

/**
 * OCR engine selection.
 *
 * Default is `local`: a bundled Tesseract engine that needs no API key, so
 * image-to-text works out of the box. `openai` keeps the older vision-model
 * path for anyone who already relies on it; `google` routes a single request
 * through the caller's own Google Cloud Vision connection.
 */
export function ocrEngine() {
  const value = (pick("OCR_PROVIDER") || "local").toLowerCase();
  return value === "tesseract" ? "local" : value;
}

/**
 * Which OCR engine a single request should use.
 *
 * @param {string} [requested] a per-request override from the client
 * @returns {"local"|"google"|"openai"}
 */
export function resolveOcrEngine(requested) {
  const value = String(requested || "").toLowerCase();
  if (value === "google") return "google";
  if (value === "openai") return "openai";
  if (value === "local" || value === "tesseract") return "local";
  return ocrEngine();
}

/**
 * OCR uploads arrive as base64 inside the JSON body, so the image is capped
 * independently of the model configuration (which may not exist at all when the
 * local engine is used).
 */
export function ocrConfig() {
  const cfg = aiConfig();
  return {
    ...cfg,
    maxImageBytes: Number(pick("OCR_MAX_IMAGE_BYTES")) || 5 * 1024 * 1024,
    maxImageChars: Math.ceil((Number(pick("OCR_MAX_IMAGE_BYTES")) || 5 * 1024 * 1024) * 1.4),
  };
}

/** True when a real provider is reachable. */
export function isConfigured(cfg = aiConfig()) {
  return Boolean(cfg.apiKey);
}

/**
 * Provider a single request should use.
 *
 * A user can pick "google" per request to route OCR through their own connected
 * Google account, which is billed to their project. That only works when they
 * have connected Google, so the caller resolves the connection first and passes
 * the choice down here.
 */
export function resolveProvider(requested) {
  const value = String(requested || "").toLowerCase();
  if (value === "google") return "google";
  return aiConfig().provider;
}

/** Short status object for `GET /api/v1/ai/status`. */
export function providerStatus() {
  const cfg = aiConfig();
  return {
    provider: cfg.provider,
    // OCR runs locally by default and does not depend on an AI key.
    ocrEngine: ocrEngine(),
    configured: isConfigured(cfg),
    mock: !isConfigured(cfg) && cfg.allowMock,
    model: cfg.chatModel,
    visionModel: cfg.visionModel,
    languages: SUPPORTED_LANGUAGES,
    actions: AI_ACTIONS,
    tones: AI_TONES,
  };
}

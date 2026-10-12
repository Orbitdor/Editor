/**
 * Voice / speech-to-text provider configuration.
 *
 * Two providers exist by design (master plan section 17):
 *   - `browser`: the browser's own Web Speech API. No key, no audio leaves the
 *     device, but it only works in Chrome/Edge/Safari and cannot be scripted.
 *   - `server`: a hosted speech-to-text endpoint. Works everywhere, costs
 *     money, and is the only option that can be tested server-side.
 *
 * The editor never depends on either directly; it talks to the abstraction in
 * `speech.provider.js` on the client and to this config on the server.
 */

/** Read a value from several possible env var names. */
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
};

export const SUPPORTED_SPEECH_LANGUAGES = ["auto", "en-US", "en-PK", "ur-PK", "ar-SA", "hi-IN"];

/** BCP-47 codes the pipeline understands, mapped to a human label. */
export const SPEECH_LANGUAGES = {
  auto: "Auto detect",
  "en-US": "English (US)",
  "en-PK": "English (Pakistan)",
  "ur-PK": "Urdu",
  "ar-SA": "Arabic",
  "hi-IN": "Hindi",
};

/** Normalised language keys used by the post-processing pipeline. */
export const LANGUAGE_KEYS = ["en", "ur", "ar", "hi"];

/**
 * Spoken editing commands (master plan section 15). Kept server-side so the
 * client and the server agree on what counts as a command.
 */
export const VOICE_COMMANDS = [
  { id: "newParagraph", phrases: ["new paragraph", "next paragraph", "paragraf", "new line"] },
  { id: "newHeading", phrases: ["make this a heading", "new heading", "heading", "title"] },
  { id: "bold", phrases: ["make this bold", "bold this", "bold"] },
  { id: "italic", phrases: ["make this italic", "italic this", "italic"] },
  { id: "underline", phrases: ["make this underlined", "underline this", "underline"] },
  { id: "bulletList", phrases: ["bullet list", "make a list", "start a list", "bullet point"] },
  { id: "numberedList", phrases: ["numbered list", "numbered list please", "numbered"] },
  { id: "deleteSentence", phrases: ["delete previous sentence", "delete last sentence", "undo that"] },
  { id: "insertPageBreak", phrases: ["page break", "new page"] },
  { id: "stop", phrases: ["stop listening", "stop recording", "stop"] },
];

/** Phrases that sound like commands but are common speech; never treated as commands. */
const COMMAND_STOPWORDS = new Set(["the", "a", "that", "this", "make", "new", "please"]);

/**
 * Longest phrase in the command table, so a transcript is scanned with a window
 * that is guaranteed to contain a full phrase.
 */
export const MAX_COMMAND_WORDS = Math.max(
  ...VOICE_COMMANDS.flatMap((c) => c.phrases).map((p) => p.split(" ").length)
);

export function voiceConfig() {
  return {
    provider: (pick("VOICE_PROVIDER") || "server").toLowerCase(),
    // Hosted speech-to-text. Any OpenAI-compatible /audio/transcriptions URL works.
    baseUrl: pick("VOICE_BASE_URL", "OPENAI_BASE_URL") || "https://api.openai.com/v1",
    apiKey: pick("OPENAI_API_KEY", "VOICE_API_KEY"),
    model: pick("VOICE_MODEL", "OPENAI_TRANSCRIBE_MODEL") || "whisper-1",
    // Allows the pipeline to run offline in development and in tests.
    allowMock: (pick("VOICE_ALLOW_MOCK") || "true").toLowerCase() !== "false",
    // Abuse limits: a single recording is capped, and the daily total too.
    maxClipSeconds: Number(pick("VOICE_MAX_CLIP_SECONDS")) || 120,
    maxAudioBytes: Number(pick("VOICE_MAX_AUDIO_BYTES")) || 15 * 1024 * 1024,
    timeoutMs: Number(pick("VOICE_TIMEOUT_MS")) || 60000,
  };
}

/** Minutes of speech allowed per day per user. */
export const VOICE_DAILY_MINUTES = Number(pick("VOICE_DAILY_MINUTES")) || 30;

/** True when a real server-side provider is reachable. */
export function isVoiceConfigured(cfg = voiceConfig()) {
  return Boolean(cfg.apiKey);
}

/** Capability snapshot for `GET /api/v1/voice/status`. */
export function voiceStatus() {
  const cfg = voiceConfig();
  return {
    provider: cfg.provider,
    configured: isVoiceConfigured(cfg),
    mock: !isVoiceConfigured(cfg) && cfg.allowMock,
    model: cfg.model,
    languages: SUPPORTED_SPEECH_LANGUAGES,
    commands: VOICE_COMMANDS.map((c) => ({ id: c.id, phrases: c.phrases })),
    limits: {
      maxClipSeconds: cfg.maxClipSeconds,
      maxAudioBytes: cfg.maxAudioBytes,
      dailyMinutes: VOICE_DAILY_MINUTES,
    },
  };
}

/** Language hints appended to the transcription prompt, when meaningful. */
export function languageHint(code) {
  if (!code || code === "auto") return "";
  return SPEECH_LANGUAGES[code] || "";
}

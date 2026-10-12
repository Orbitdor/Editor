import { voiceConfig, languageHint } from "../config/voice.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Speech-to-text provider adapter.
 *
 * Mirrors `ai.provider.js`: the rest of the backend calls `transcribeAudio` and
 * never learns which engine ran. Two providers exist (master plan section 17):
 *
 *   - `browser`: the client uses the Web Speech API and sends only the finished
 *     transcript. Free, private, and no server cost, but the text arrives
 *     unpunctuated and the browser does the work.
 *   - `server`: audio is uploaded and transcribed here. Works in every browser
 *     and gives better accuracy, but costs money per minute.
 *
 * Audio arrives as a base64 data URL so no multipart parser is needed, the same
 * trick the OCR endpoint uses.
 */

/** Offline stand-in so the flow can be exercised without a key. */
function mockTranscript(language) {
  const hint = languageHint(language);
  return `[mock speech provider] Transcription placeholder${hint ? ` for ${hint}` : ""}.\n\nSet OPENAI_API_KEY in backend/.env to enable real speech-to-text.`;
}

/** POST a multipart form to the provider's transcription endpoint. */
async function postMultipart(cfg, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(502, `Speech provider error (${res.status})`, text.slice(0, 500));
    }
    return res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === "AbortError") throw new ApiError(504, "Speech provider timed out");
    throw new ApiError(502, "Could not reach the speech provider", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe a recorded clip.
 *
 * @param {object} params
 * @param {string} params.audioDataUrl `data:audio/webm;base64,...`
 * @param {string} [params.language] `auto` or a BCP-47 code such as `ur-PK`.
 * @param {number} [params.durationSeconds] Clip length, for logging and quota.
 * @returns {Promise<{text: string, model: string, mock: boolean, provider: string}>}
 */
export async function transcribeAudio({ audioDataUrl, language = "auto", durationSeconds = 0 }) {
  const cfg = voiceConfig();

  if (!audioDataUrl) throw new ApiError(400, "Audio is required");

  if (durationSeconds > cfg.maxClipSeconds) {
    throw new ApiError(413, `Recording is too long (limit ${cfg.maxClipSeconds}s)`);
  }

  if (!/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audioDataUrl)) {
    throw new ApiError(400, "Audio must be a base64 data URL");
  }
  if (audioDataUrl.length > cfg.maxAudioBytes) {
    throw new ApiError(413, "Audio clip is too large to process");
  }

  if (!cfg.apiKey) {
    if (!cfg.allowMock) {
      throw new ApiError(503, "Speech-to-text is not configured. Set OPENAI_API_KEY on the server.");
    }
    return {
      text: mockTranscript(language),
      model: "mock",
      mock: true,
      provider: "mock",
      durationSeconds,
    };
  }

  // The data URL prefix carries the real mime type, e.g. `audio/webm`.
  const [, mime, encoded] = /^data:(audio\/[a-z0-9.+-]+);base64,(.*)$/i.exec(audioDataUrl) || [];
  const bytes = Buffer.from(encoded || "", "base64");
  if (!bytes.length) throw new ApiError(400, "Audio clip was empty");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "clip.webm");
  form.append("model", cfg.model);
  form.append("response_format", "json");
  // `auto` is not accepted by every provider, so only send a concrete code.
  if (language && language !== "auto") form.append("language", language);

  const json = await postMultipart(cfg, form);
  const text = typeof json?.text === "string" ? json.text.trim() : "";

  return {
    text,
    model: cfg.model,
    mock: false,
    provider: cfg.provider,
    durationSeconds,
  };
}

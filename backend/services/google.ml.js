import { ApiError } from "../utils/ApiError.js";

/**
 * Google Cloud Speech-to-Text and Vision providers.
 *
 * These are alternatives inside the existing provider abstractions, not new
 * services. A user with a Google connection can pick "Google" instead of the
 * default vendor, and because the tokens come from their own connected account
 * the calls are billed to their project rather than the app's.
 *
 * Both are reached with a REST call, so no SDK dependency is needed. The
 * endpoint names can be overridden because Google ships regional variants, and
 * because Speech-to-Text v2 uses a different URL shape from v1.
 */

/** v1 recognises `en-US`, `ur-PK` and so on, so the tags come from our codes. */
const SPEECH_LANGUAGE_TAGS = {
  en: "en-US",
  ur: "ur-PK",
  ar: "ar-SA",
  hi: "hi-IN",
  "en-US": "en-US",
  "en-PK": "en-PK",
  "ur-PK": "ur-PK",
  "ar-SA": "ar-SA",
  "hi-IN": "hi-IN",
};

function pick(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function speechConfig() {
  return {
    // v2 handles more languages and returns better punctuation, which matters
    // because the editor's cleanup expects punctuated input.
    endpoint: pick("GOOGLE_SPEECH_ENDPOINT") || "https://speech.googleapis.com/v2/speech:recognize",
    projectId: pick("GOOGLE_CLOUD_PROJECT"),
  };
}

function visionConfig() {
  const base = pick("GOOGLE_VISION_ENDPOINT") || "https://vision.googleapis.com/v1";
  return {
    endpoint: `${base}/images:annotate`,
    ocrEndpoint: pick("GOOGLE_DOCUMENT_AI_ENDPOINT") || "",
    projectId: pick("GOOGLE_CLOUD_PROJECT"),
  };
}

/** True when the Google endpoints can be called for real. */
export function isGoogleSpeechConfigured() {
  const cfg = speechConfig();
  return Boolean(cfg.projectId && pick("GOOGLE_API_KEY"));
}

export function isGoogleVisionConfigured() {
  return Boolean(pick("GOOGLE_API_KEY"));
}

/** POST JSON to Google with a timeout, translating failures into ApiErrors. */
async function postJson(url, { body, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(403, "Google rejected these credentials for this operation", text.slice(0, 300));
      }
      throw new ApiError(502, `Google request failed (${res.status})`, text.slice(0, 500));
    }
    return res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === "AbortError") throw new ApiError(504, "Google took too long to respond");
    throw new ApiError(502, "Could not reach Google", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe a clip with Google Speech-to-Text v2.
 *
 * @param {object} params
 * @param {string} params.audioDataUrl `data:audio/webm;base64,...`
 * @param {string} [params.language] `auto` or a language code.
 * @param {string} [params.accessToken] OAuth token from the user's connection.
 * @param {string} [params.apiKey] Server key, when no user connection is used.
 * @returns {Promise<{text: string, mock: boolean, provider: string}>}
 */
export async function transcribeWithGoogle({ audioDataUrl, language = "auto", accessToken, apiKey = pick("GOOGLE_API_KEY") }) {
  if (!audioDataUrl) throw new ApiError(400, "Audio is required");
  if (!accessToken && !apiKey) {
    throw new ApiError(503, "Google Speech is not available. Connect your Google account first.");
  }

  const [, mime, encoded] = /^data:(audio\/[a-z0-9.+-]+);base64,(.*)$/i.exec(audioDataUrl) || [];
  if (!encoded) throw new ApiError(400, "Audio must be a base64 data URL");

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new ApiError(400, "Audio clip was empty");

  // Cloud Speech accepts raw audio bytes; base64 is the wire encoding, not the
  // storage format, so the decoded bytes are what gets sent.
  const body = {
    config: {
      encoding: "WEBM_OPUS",
      sampleRateHertz: 48000,
      languageCode: SPEECH_LANGUAGE_TAGS[language] || "en-US",
      // The editor adds its own paragraphs and punctuation pass afterwards.
      enableAutomaticPunctuation: true,
      model: "long",
    },
    content: bytes.toString("base64"),
  };

  const cfg = speechConfig();
  const json = await postJson(
    `${cfg.endpoint}${cfg.projectId ? `?key=${cfg.projectId}` : ""}`,
    { body, headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : { "X-Goog-Api-Key": apiKey } }
  );

  const text = (json?.results || [])
    .map((result) => result?.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim();

  return { text, mock: false, provider: "google", mimeType: mime };
}

/**
 * Extract text from an image with Google Cloud Vision.
 *
 * Vision's `TEXT_DETECTION` is cheaper and faster for a screenshot, but
 * `DOCUMENT_TEXT_DETECTION` preserves layout, which is what a scanned page
 * needs. Plain text detection is used first and the document model is used when
 * the image looks like a page rather than a photo.
 *
 * @param {object} params
 * @param {string} params.imageDataUrl `data:image/...;base64,...`
 * @param {string} [params.accessToken] OAuth token from the user's connection.
 * @param {string} [params.apiKey]
 * @returns {Promise<{text: string, mock: boolean, provider: string}>}
 */
export async function ocrWithGoogle({ imageDataUrl, accessToken, apiKey = pick("GOOGLE_API_KEY") }) {
  if (!imageDataUrl) throw new ApiError(400, "An image is required");
  if (!accessToken && !apiKey) {
    throw new ApiError(503, "Google Vision is not available. Connect your Google account first.");
  }

  const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(imageDataUrl);
  if (!match) throw new ApiError(400, "Image must be a base64 image data URL");

  const [, mime, encoded] = match;
  const cfg = visionConfig();

  const json = await postJson(cfg.endpoint, {
    body: {
      requests: [
        {
          image: { content: encoded },
          features: [
            { type: "DOCUMENT_TEXT_DETECTION" },
            { type: "TEXT_DETECTION" },
          ],
          imageContext: { languageHints: ["en", "ur", "ar", "hi"] },
        },
      ],
    },
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : { "X-Goog-Api-Key": apiKey },
  });

  const response = json?.responses?.[0];
  const text =
    response?.fullTextAnnotation?.text ||
    response?.textAnnotations?.[0]?.description ||
    "";

  return { text: String(text).trim(), mock: false, provider: "google", mimeType: mime };
}

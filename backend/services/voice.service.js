import VoiceTranscription from "../models/VoiceTranscription.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorize } from "./access.service.js";
import { transcribeAudio } from "./speech.provider.js";
import { transcribeWithGoogle } from "./google.ml.js";
import { connectionHas, getConnection, withAccessToken } from "./google.oauth.js";
import { resolveProvider } from "../config/ai.js";
import { processTranscript } from "./voice.process.js";
import * as usage from "./usage.service.js";
import { SUPPORTED_SPEECH_LANGUAGES, VOICE_DAILY_MINUTES, voiceConfig } from "../config/voice.js";
import { LANGUAGES } from "../config/ai.js";

/**
 * Voice dictation service.
 *
 * Two entry points, because the two providers do different amounts of work:
 *
 *   - `transcribeClip` uploads audio and runs the whole pipeline here. Used when
 *     the server provider is active.
 *   - `finishDictation` takes a transcript the browser already produced through
 *     the Web Speech API and only cleans it up. Audio never leaves the device,
 *     but quota is still charged so the feature cannot be used for free without
 *     a limit.
 *
 * Both keep the raw transcript next to the cleaned text (master plan section 18)
 * and both return text for review. Nothing is inserted into the document here.
 */

/** Language code -> human label, covering speech and OCR label sets. */
function languageName(code) {
  if (!code) return "Unknown";
  return LANGUAGES[code] || code;
}

/**
 * Pick which speech backend to use.
 *
 * As with OCR, "google" routes through the caller's own Google connection so the
 * cost lands on their project. A missing connection is an explicit error rather
 * than a silent fallback, because swapping engines would change the price and
 * the transcript.
 */
async function resolveSpeechProvider(userId, requested) {
  const choice = resolveProvider(requested);

  if (choice === "google") {
    const connection = await getConnection(userId);
    if (!connectionHas(connection, "speech")) {
      throw new ApiError(412, "Connect Google with Cloud Speech access to use Google transcription");
    }
    return { choice, accessToken: await withAccessToken(connection) };
  }

  return { choice, accessToken: null };
}

/** Reject unknown languages before any audio is processed. */
function assertLanguage(language) {
  if (language && !SUPPORTED_SPEECH_LANGUAGES.includes(language)) {
    throw new ApiError(400, `Unsupported language: ${language}`);
  }
}

/** Approximate the decoded byte size of a base64 data URL. */
function decodedSize(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Transcribe an uploaded clip: audio in, cleaned text out.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {{audio: string, language?: string, durationSeconds?: number, provider?: string}} params
 */
export async function transcribeClip(docId, userId, { audio, language = "auto", durationSeconds = 0, provider: requestedProvider } = {}) {
  assertLanguage(language);

  // Dictation inserts text, so it needs the same access bar as OCR.
  const { doc } = await authorize(docId, userId, "commenter");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  const cfg = voiceConfig();
  const seconds = Math.max(0, Number(durationSeconds) || 0);

  if (!audio) throw new ApiError(400, "Audio is required");
  if (seconds > cfg.maxClipSeconds) {
    throw new ApiError(413, `Recording is too long (limit ${cfg.maxClipSeconds} seconds)`);
  }
  if (audio.length > cfg.maxAudioBytes) {
    throw new ApiError(413, "Audio clip is too large to process");
  }

  // Voice is metered in seconds, so the daily ceiling is checked against the
  // clip length rather than a request count.
  await usage.assertWithinVoiceQuota(userId, seconds, doc.workspace);

  const { choice, accessToken } = await resolveSpeechProvider(userId, requestedProvider);

  const record = await VoiceTranscription.create({
    document: doc._id,
    user: userId,
    provider: choice,
    language,
    durationSeconds: seconds,
    status: "processing",
  });

  const startedAt = Date.now();
  try {
    const result =
      choice === "google"
        ? await transcribeWithGoogle({ audioDataUrl: audio, language, accessToken })
        : await transcribeAudio({
            audioDataUrl: audio,
            language,
            durationSeconds: seconds,
          });

    const raw = result.text || "";
    const { text, commands, language: detected } = processTranscript(raw);

    record.status = "done";
    record.rawTranscript = raw;
    record.processedText = text;
    record.detectedLanguage = detected.code;
    await record.save();

    await usage.recordUsage(userId, {
      inputChars: decodedSize(audio),
      outputChars: text.length,
      voice: seconds || Math.ceil(raw.length / 12), // ~12 chars per second of speech
      document: doc._id,
      workspace: doc.workspace,
    });

    return {
      transcriptionId: String(record._id),
      rawTranscript: raw,
      text,
      commands,
      detectedLanguage: detected.code,
      languageName: languageName(detected.code),
      confidence: detected.confidence,
      provider: result.provider,
      mock: Boolean(result.mock),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    record.status = "failed";
    record.error = err.message;
    await record.save().catch(() => {});
    throw err;
  }
}

/**
 * Clean up a transcript the browser already produced.
 *
 * The Web Speech API path never sends audio to the server, so the only work
 * done here is punctuation, paragraph splitting, command extraction and the
 * language check. Usage is still recorded against the voice bucket so the daily
 * minute limit applies to this path too.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {{transcript: string, language?: string, durationSeconds?: number, provider?: string}} params
 */
export async function finishDictation(
  docId,
  userId,
  { transcript, language = "auto", durationSeconds = 0, provider = "browser" } = {}
) {
  assertLanguage(language);

  const { doc } = await authorize(docId, userId, "commenter");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  if (!transcript || !String(transcript).trim()) {
    throw new ApiError(400, "No speech was recognised");
  }

  const seconds = Math.max(0, Number(durationSeconds) || 0);
  await usage.assertWithinVoiceQuota(userId, seconds, doc.workspace);

  const record = await VoiceTranscription.create({
    document: doc._id,
    user: userId,
    provider,
    language,
    durationSeconds: seconds,
    status: "processing",
  });

  try {
    const { text, commands, language: detected } = processTranscript(String(transcript));

    record.status = "done";
    record.rawTranscript = String(transcript);
    record.processedText = text;
    record.processedClientSide = true;
    record.detectedLanguage = detected.code;
    await record.save();

    await usage.recordUsage(userId, {
      outputChars: text.length,
      voice: seconds || Math.ceil(String(transcript).length / 12),
      document: doc._id,
      workspace: doc.workspace,
    });

    return {
      transcriptionId: String(record._id),
      rawTranscript: String(transcript),
      text,
      commands,
      detectedLanguage: detected.code,
      languageName: languageName(detected.code),
      confidence: detected.confidence,
      provider,
      mock: false,
      durationMs: 0,
    };
  } catch (err) {
    record.status = "failed";
    record.error = err.message;
    await record.save().catch(() => {});
    throw err;
  }
}

/** One transcription, if the caller can see the document. */
export async function getTranscription(docId, transcriptionId, userId) {
  await authorize(docId, userId, "viewer");
  const row = await VoiceTranscription.findById(transcriptionId).lean();
  if (!row || String(row.document) !== String(docId)) {
    throw new ApiError(404, "Transcription not found");
  }
  return {
    transcriptionId: String(row._id),
    status: row.status,
    rawTranscript: row.rawTranscript,
    text: row.processedText,
    detectedLanguage: row.detectedLanguage,
    provider: row.provider,
    durationSeconds: row.durationSeconds,
    error: row.error,
    createdAt: row.createdAt,
  };
}

/** Recent dictation sessions for a document. */
export async function listTranscriptions(docId, userId, limit = 10) {
  await authorize(docId, userId, "viewer");
  const rows = await VoiceTranscription.find({ document: docId })
    .sort("-createdAt")
    .limit(Math.min(Number(limit) || 10, 50))
    .lean();

  return rows.map((r) => ({
    transcriptionId: String(r._id),
    status: r.status,
    detectedLanguage: r.detectedLanguage,
    provider: r.provider,
    durationSeconds: r.durationSeconds,
    error: r.error,
    preview: (r.processedText || "").slice(0, 120),
    createdAt: r.createdAt,
  }));
}

/** Voice capability and remaining quota, for the microphone button's tooltip. */
export async function voiceStatus(userId) {
  const cfg = voiceConfig();
  const { day } = await usage.currentUsage(userId);
  const remaining = Math.max(0, VOICE_DAILY_MINUTES * 60 - (day.voiceSeconds || 0));

  return {
    provider: cfg.provider,
    // The browser provider always works, so the feature is available even with
    // no server key. This flag only describes the server-side path.
    serverConfigured: Boolean(cfg.apiKey),
    mock: !cfg.apiKey && cfg.allowMock,
    model: cfg.model,
    languages: SUPPORTED_SPEECH_LANGUAGES,
    dailyMinutes: VOICE_DAILY_MINUTES,
    minutesRemainingToday: Math.floor(remaining / 60 * 10) / 10,
    maxClipSeconds: cfg.maxClipSeconds,
  };
}

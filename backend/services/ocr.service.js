import OCRJob from "../models/OCRJob.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorize } from "./access.service.js";
import * as provider from "./ai.provider.js";
import * as usage from "./usage.service.js";
import { detectLanguage, cleanOcrText, toBlocks, detectInvoiceFields } from "./ocr.process.js";
import { LANGUAGES, ocrConfig, resolveProvider } from "../config/ai.js";
import { ocrWithGoogle } from "./google.ml.js";
import { connectionHas, getConnection, withAccessToken } from "./google.oauth.js";

/**
 * Image -> Text OCR service.
 *
 * Flow: authorize -> quota check -> provider extraction -> cleanup / language
 * detection / block structuring -> persist job -> record usage.
 *
 * The result is never written into the document automatically; the client
 * reviews it and inserts it, so the user always keeps control of their content.
 */

/** Validate the base64 image payload before it reaches the provider. */
function assertImagePayload(image, maxChars) {
  if (!image || typeof image !== "string") {
    throw new ApiError(400, "An image is required");
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(image)) {
    throw new ApiError(400, "Image must be a base64 PNG, JPEG, WebP or GIF data URL");
  }
  if (image.length > maxChars) {
    throw new ApiError(413, "Image is too large to process");
  }
}

/** Approximate the decoded byte size of a base64 data URL. */
function decodedSize(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Pick which OCR backend to use.
 *
 * "google" routes through the caller's own Google connection, so their Google
 * project is billed instead of the app's. That is only possible when they have
 * connected Google with the vision scope; otherwise the request is rejected
 * rather than silently falling back, because silently using a different engine
 * would change both the cost and the result.
 */
async function resolveOcrProvider(userId, requested) {
  const choice = resolveProvider(requested);

  if (choice === "google") {
    const connection = await getConnection(userId);
    if (!connectionHas(connection, "vision")) {
      throw new ApiError(412, "Connect Google with Cloud Vision access to use Google OCR");
    }
    const accessToken = await withAccessToken(connection);
    return { choice, accessToken };
  }

  return { choice, accessToken: null };
}

/**
 * Run OCR on an uploaded image and return the cleaned result.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {{image: string, language?: string, provider?: string}} params
 */
export async function runOcr(docId, userId, { image, language = "auto", provider: requestedProvider } = {}) {
  if (language && !LANGUAGES[language]) {
    throw new ApiError(400, `Unsupported language: ${language}`);
  }

  const { doc } = await authorize(docId, userId, "commenter");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  // OCR is billed like a write, so require at least commenter (read-only
  // viewers do not insert text). Cap payload before spending quota.
  assertImagePayload(image, ocrConfig().maxImageChars);

  await usage.assertWithinOcrQuota(userId, doc.workspace);

  const { choice, accessToken } = await resolveOcrProvider(userId, requestedProvider);

  const job = await OCRJob.create({
    document: doc._id,
    user: userId,
    language,
    provider: choice,
    status: "processing",
  });

  const startedAt = Date.now();
  try {
    const extracted =
      choice === "google"
        ? await ocrWithGoogle({ imageDataUrl: image, accessToken })
        : await provider.extractTextFromImage({ imageDataUrl: image, language });
    const raw = extracted.text || "";
    const text = cleanOcrText(raw);
    const detected = language !== "auto" ? { code: language, confidence: 100 } : detectLanguage(text);
    const blocks = toBlocks(text);
    const invoice = detectInvoiceFields(text);

    job.status = "done";
    job.rawText = raw;
    job.text = text;
    job.blocks = blocks;
    job.detectedLanguage = detected.code;
    job.confidence = detected.confidence;
    job.durationMs = Date.now() - startedAt;
    await job.save();

    await usage.recordUsage(userId, {
      inputChars: decodedSize(image),
      outputChars: text.length,
      ocr: true,
      document: doc._id,
      workspace: doc.workspace,
    });

    return {
      jobId: String(job._id),
      text,
      blocks,
      detectedLanguage: detected.code,
      languageName: LANGUAGES[detected.code] || detected.code,
      confidence: detected.confidence,
      invoice,
      mock: Boolean(extracted.mock),
      durationMs: job.durationMs,
    };
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.durationMs = Date.now() - startedAt;
    await job.save().catch(() => {});
    throw err;
  }
}

/** One OCR job, if the caller can see the document. */
export async function getJob(docId, jobId, userId) {
  await authorize(docId, userId, "viewer");
  const job = await OCRJob.findById(jobId).lean();
  if (!job || String(job.document) !== String(docId)) throw new ApiError(404, "OCR job not found");
  return {
    jobId: String(job._id),
    status: job.status,
    text: job.text,
    blocks: job.blocks,
    detectedLanguage: job.detectedLanguage,
    confidence: job.confidence,
    error: job.error,
    createdAt: job.createdAt,
  };
}

/** Recent OCR jobs for a document. */
export async function listJobs(docId, userId, limit = 10) {
  await authorize(docId, userId, "viewer");
  const rows = await OCRJob.find({ document: docId })
    .sort("-createdAt")
    .limit(Math.min(Number(limit) || 10, 50))
    .lean();

  return rows.map((r) => ({
    jobId: String(r._id),
    status: r.status,
    detectedLanguage: r.detectedLanguage,
    confidence: r.confidence,
    error: r.error,
    preview: (r.text || "").slice(0, 120),
    createdAt: r.createdAt,
  }));
}

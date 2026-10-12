import { ApiError } from "../utils/ApiError.js";
import { authorize } from "./access.service.js";
import * as provider from "./ai.provider.js";
import * as usage from "./usage.service.js";
import { plainTextOf } from "../utils/text.js";
import { AI_ACTIONS, DOCUMENT_ACTIONS, LANGUAGES } from "../config/ai.js";

/**
 * AI writing assistant and document-QA service.
 *
 * Owns authorization, quota accounting and the document-context assembly, then
 * hands the actual completion off to the provider adapter.
 */

/** Longest document text sent as "context" alongside a selection. */
const CONTEXT_CHARS = 2000;

/**
 * Run a writing-assistant action against a document.
 *
 * Any role with edit access may use AI on a document; a viewer cannot, because
 * the result is normally inserted back into the body.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {{action: string, text?: string, tone?: string, language?: string, selection?: string}} params
 */
export async function runAction(docId, userId, params = {}) {
  const { action, text, tone, language, selection } = params;

  if (!AI_ACTIONS.includes(action)) {
    throw new ApiError(400, `Unsupported AI action: ${action}`);
  }
  if (language && !LANGUAGES[language]) {
    throw new ApiError(400, `Unsupported language: ${language}`);
  }

  const { doc } = await authorize(docId, userId, "editor");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  await usage.assertWithinQuota(userId, doc.workspace);

  // Prefer the client-supplied selection; fall back to the stored body so the
  // whole-document actions (summarize, key-points) work without a selection.
  const docText = plainTextOf(doc);
  const source = (selection || text || "").trim() || (DOCUMENT_ACTIONS.has(action) ? docText : "");

  const context = DOCUMENT_ACTIONS.has(action) ? "" : docText.slice(0, CONTEXT_CHARS);

  const result = await provider.runTextAction({ action, text: source, tone, language, context });

  await usage.recordUsage(userId, {
    inputChars: source.length + context.length,
    outputChars: result.text.length,
    document: doc._id,
    workspace: doc.workspace,
  });

  return {
    action,
    result: result.text,
    model: result.model,
    mock: result.mock,
    usedDocument: !selection && DOCUMENT_ACTIONS.has(action),
  };
}

/**
 * Free-form question about a document ("ask about document" in the AI panel).
 * Viewers may ask questions: nothing is written back to the document.
 */
export async function askAboutDocument(docId, userId, { question, language = "en" } = {}) {
  if (!LANGUAGES[language] || language === "auto") language = "en";

  const { doc } = await authorize(docId, userId, "viewer");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  await usage.assertWithinQuota(userId, doc.workspace);

  const docText = plainTextOf(doc);
  const result = await provider.askAboutDocument({ question, documentText: docText, language });

  await usage.recordUsage(userId, {
    inputChars: question.length + docText.length,
    outputChars: result.text.length,
    document: doc._id,
    workspace: doc.workspace,
  });

  return { answer: result.text, mock: result.mock, documentId: String(doc._id) };
}

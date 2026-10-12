import { aiConfig, AI_ACTIONS, DOCUMENT_ACTIONS } from "../config/ai.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Text-to-text and vision provider adapter.
 *
 * The rest of the backend talks to this module only, so swapping OpenAI for
 * another vendor (or the local mock used in tests) touches one file. Requests
 * go through `fetch`, which Node 18+ provides, so no SDK dependency is needed.
 */

/** System instructions per action. Kept short and imperative for cost. */
const INSTRUCTIONS = {
  improve: "Rewrite the text to be clearer and better written. Keep the original meaning, tone and roughly the same length. Return only the rewritten text.",
  "fix-grammar": "Fix all spelling, grammar and punctuation errors. Keep the wording, meaning and language unchanged. Return only the corrected text.",
  rewrite: "Rewrite the text in fresh wording while preserving the meaning and the original language. Return only the rewritten text.",
  professional: "Rewrite the text in a professional, business-appropriate register. Keep the meaning and language. Return only the rewritten text.",
  concise: "Make the text more concise, removing filler and redundancy. Keep every important point. Return only the shorter text.",
  expand: "Expand the text with more detail, explanation and examples. Keep the meaning and language. Return only the expanded text.",
  summarize: "Summarize the text. Keep the key points and use short sentences. Return only the summary.",
  translate: "Translate the text into the requested target language. Preserve the meaning and keep any formatting such as lists. Return only the translation.",
  continue: "Continue writing the text naturally in the same language, tone and style. Return only the continuation, without repeating the original text.",
  tone: "Rewrite the text in the requested tone. Keep the meaning and language. Return only the rewritten text.",
  explain: "Explain the text in plain, simple language. Keep the language of the source text. Return only the explanation.",
  "extract-tasks": "Extract every action item, task or deadline from the text as a Markdown checklist. Use `- [ ] ` for each item. Return only the checklist, or `NO_TASKS` if there are none.",
  "key-points": "List the key points of the text as a Markdown bullet list. Return only the bullets.",
};

const TONE_HINT = {
  formal: "formal and polished",
  friendly: "friendly and warm",
  confident: "confident and assertive",
  concise: "concise and direct",
  persuasive: "persuasive and motivating",
  professional: "professional and business-appropriate",
  empathetic: "empathetic and understanding",
  technical: "precise and technical",
};

function instructionsFor(action) {
  const base = INSTRUCTIONS[action];
  if (!base) throw new ApiError(400, `Unsupported AI action: ${action}`);
  return base;
}

/** Raise the "rewrite in tone X" instruction to the requested tone. */
function withTone(instruction, tone) {
  const hint = TONE_HINT[String(tone || "").toLowerCase()];
  return hint ? `${instruction} Target tone: ${hint}.` : instruction;
}

/** Enforce the input ceiling before spending tokens. */
function clampInput(cfg, text) {
  const value = String(text ?? "");
  if (value.length > cfg.maxInputChars) {
    throw new ApiError(
      413,
      `Text is too long for AI processing (limit ${cfg.maxInputChars} characters)`
    );
  }
  return value;
}

/** POST helper with a timeout so a slow provider cannot hang a request. */
async function postJson(cfg, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(502, `AI provider error (${res.status})`, text.slice(0, 500));
    }
    return res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === "AbortError") {
      throw new ApiError(504, "AI provider timed out");
    }
    throw new ApiError(502, "Could not reach the AI provider", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the assistant text out of an OpenAI-compatible chat completion. */
function readChatCompletion(json) {
  return json?.choices?.[0]?.message?.content ?? "";
}

/**
 * Deterministic offline provider.
 *
 * Used when no API key is configured and `AI_ALLOW_MOCK` is on. It lets the UI,
 * the routing and the tests run end to end; the response is clearly marked so a
 * mock result is never mistaken for a real completion.
 */
function mockCompletion(prompt) {
  const firstLine = String(prompt)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("[") && l.length > 3);

  const body = firstLine ? firstLine.slice(0, 400) : "the document";
  return `[mock provider] Processed: "${body}"\n\nSet OPENAI_API_KEY in backend/.env for real AI results.`;
}

/**
 * Run a text action. Returns `{ text, model, mock }`.
 *
 * @param {object} params
 * @param {string} params.action One of `AI_ACTIONS`.
 * @param {string} params.text Source text (selection or document body).
 * @param {string} [params.tone] Required for the `tone` action.
 * @param {string} [params.language] Target language for `translate`, e.g. `ur`.
 * @param {string} [params.context] Surrounding document text for context.
 */
export async function runTextAction({ action, text, tone, language, context = "" }) {
  if (!AI_ACTIONS.includes(action)) throw new ApiError(400, `Unsupported AI action: ${action}`);

  const cfg = aiConfig();
  const source = clampInput(cfg, text);
  if (!source.trim()) throw new ApiError(400, "Nothing to process");

  if (action === "tone" && !TONE_HINT[String(tone || "").toLowerCase()]) {
    throw new ApiError(400, "A valid tone is required for this action");
  }
  if (action === "translate" && !language) {
    throw new ApiError(400, "A target language is required to translate");
  }

  const instruction = withTone(instructionsFor(action), tone);
  const parts = [instruction];
  if (action === "translate" && language) parts.push(`Target language: ${language}.`);
  if (context) {
    parts.push(
      `Use this surrounding document context only for tone and terminology. Never include it in the answer:\n"""\n${clampInput(
        cfg,
        context
      )}\n"""`
    );
  }
  parts.push(`Text:\n"""\n${source}\n"""`);

  const prompt = parts.join("\n\n");

  if (!cfg.apiKey) {
    if (!cfg.allowMock) {
      throw new ApiError(503, "AI is not configured. Set OPENAI_API_KEY on the server.");
    }
    return { text: mockCompletion(source), model: "mock", mock: true, inputChars: source.length };
  }

  const json = await postJson(cfg, "/chat/completions", {
    model: cfg.chatModel,
    messages: [
      { role: "system", content: "You are a precise writing assistant inside a document editor." },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    max_tokens: cfg.maxOutputTokens,
  });

  return {
    text: readChatCompletion(json).trim(),
    model: cfg.chatModel,
    mock: false,
    inputChars: source.length,
  };
}

/**
 * Ask a free-form question about a document (AI side panel "ask about document").
 * Returns a plain-text answer.
 */
export async function askAboutDocument({ question, documentText, language = "en" }) {
  const cfg = aiConfig();
  const question_ = clampInput(cfg, question);
  const context = clampInput(cfg, documentText);

  if (!question_.trim()) throw new ApiError(400, "Question is required");
  if (!context.trim()) throw new ApiError(400, "The document has no text to analyse yet");

  const prompt = [
    "Answer the question using only the document below. If the answer is not in the document, say so plainly.",
    `Answer in this language: ${language}.`,
    `Question: ${question_}`,
    `Document:\n"""\n${context}\n"""`,
  ].join("\n\n");

  if (!cfg.apiKey) {
    if (!cfg.allowMock) {
      throw new ApiError(503, "AI is not configured. Set OPENAI_API_KEY on the server.");
    }
    return { text: `[mock provider] ${question_}\n\nSet OPENAI_API_KEY for real answers.`, mock: true };
  }

  const json = await postJson(cfg, "/chat/completions", {
    model: cfg.chatModel,
    messages: [
      { role: "system", content: "You answer questions about a single document." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: cfg.maxOutputTokens,
  });

  return { text: readChatCompletion(json).trim(), mock: false };
}

/**
 * Extract text from an image (OCR). The image is sent as a base64 data URL to a
 * vision-capable chat model.
 *
 * @param {object} params
 * @param {string} params.imageDataUrl `data:image/...;base64,...`
 * @param {string} [params.language] `auto` or a language code.
 */
export async function extractTextFromImage({ imageDataUrl, language = "auto" }) {
  const cfg = aiConfig();
  if (!imageDataUrl) throw new ApiError(400, "An image is required");
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(imageDataUrl)) {
    throw new ApiError(400, "Image must be a base64 PNG, JPEG, WebP or GIF data URL");
  }
  if (imageDataUrl.length > cfg.maxImageChars) {
    throw new ApiError(413, "Image is too large to process");
  }

  const langNote =
    language && language !== "auto"
      ? `The text is expected to be in ${language}.`
      : "Detect the language automatically (English, Urdu, Arabic, Roman Urdu or Hindi).";

  if (!cfg.apiKey) {
    if (!cfg.allowMock) {
      throw new ApiError(503, "OCR is not configured. Set OPENAI_API_KEY on the server.");
    }
    return {
      text: "[mock OCR provider] No image was processed.\n\nSet OPENAI_API_KEY in backend/.env to enable real OCR.",
      mock: true,
    };
  }

  const prompt = [
    "Transcribe every piece of text visible in this image.",
    langNote,
    "Preserve line breaks, list markers and table layout. Do not add commentary.",
  ].join(" ");

  const json = await postJson(cfg, "/chat/completions", {
    model: cfg.visionModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: cfg.maxOutputTokens,
  });

  return { text: readChatCompletion(json).trim(), mock: false };
}

/**
 * Build a document skeleton from a short prompt (master plan section 33).
 *
 * This is the one call in the app that wants structured JSON rather than prose, so
 * it asks for JSON mode and then validates the shape itself. A model can still
 * return prose or malformed JSON, and that must degrade into a usable error rather
 * than a half-built template saved into someone's workspace.
 *
 * Returns `{ title, description, category, content, fields, tags, mock }`.
 *
 * @param {object} params
 * @param {string} params.prompt e.g. "Create a software proposal"
 * @param {string} [params.category] The template category to aim for.
 * @param {string} [params.kind] A human label for the kind, e.g. "Proposal".
 */
export async function generateTemplateStructure({ prompt, category = "Business", kind = "" }) {
  const cfg = aiConfig();
  const ask = clampInput(cfg, prompt);
  if (!ask.trim()) throw new ApiError(400, "Describe the document you want");

  if (!cfg.apiKey) {
    if (!cfg.allowMock) {
      throw new ApiError(503, "AI is not configured. Set OPENAI_API_KEY on the server.");
    }
    return { ...mockTemplateStructure(ask, category, kind), mock: true };
  }

  const system = [
    "You design document templates for a collaborative editor.",
    "Return a single JSON object and nothing else. No prose, no markdown fence.",
    'Shape: {"title":string,"description":string,"category":string,"content":string,"fields":[{"name":string,"label":string,"type":string,"hint":string,"required":boolean}],"tags":string[]}',
    "content is editor HTML using only <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>, <pre>, <hr> and <table>.",
    "Put a {{placeholder}} wherever the user must supply their own detail, using lower_snake_case names.",
    "Write the headings and the structural prose yourself. Never leave a section as a bare heading with nothing under it.",
    "category must be one of: Blank, Business, Education, Personal, Custom.",
    "field type must be one of: text, textarea, date, number, select.",
    "Aim for a document a person would actually send: 5 to 10 sections, not a stub.",
  ].join(" ");

  const user = [
    `Template category: ${category}.`,
    kind ? `Kind: ${kind}.` : "",
    `Request: ${ask}`,
  ].filter(Boolean).join("\n");

  const json = await postJson(cfg, "/chat/completions", {
    model: cfg.chatModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_tokens: cfg.maxOutputTokens,
    response_format: { type: "json_object" },
  });

  const raw = readChatCompletion(json).trim();
  const parsed = parseTemplateJson(raw);

  return {
    title: String(parsed.title || "").trim().slice(0, 160) || "New template",
    description: String(parsed.description || "").trim().slice(0, 400),
    category: typeof parsed.category === "string" ? parsed.category : category,
    content: String(parsed.content || "").trim(),
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).slice(0, 40)) : [],
    mock: false,
  };
}

/**
 * Read the model's JSON.
 *
 * Tolerates a markdown fence, which models add even when told not to, and treats
 * a JSON array as a single-element document template so a `[{...}]` reply still
 * works. Anything else is a 502: better to ask again than to save an empty body.
 */
function parseTemplateJson(raw) {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!cleaned) throw new ApiError(502, "The AI returned an empty template");

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new ApiError(502, "The AI did not return a usable template. Try again.");
  }
  if (Array.isArray(data)) data = data[0];
  if (!data || typeof data !== "object") {
    throw new ApiError(502, "The AI did not return a usable template. Try again.");
  }
  // A template with no body is not a template: the picker would offer a blank card.
  if (!String(data.content || "").trim()) {
    throw new ApiError(502, "The AI returned a template with no content. Try again.");
  }
  return data;
}

/**
 * Offline skeleton, used when no API key is set.
 *
 * It returns a real document shape with real placeholders rather than a sentence
 * saying the feature is unconfigured, so the template flow is demonstrable and
 * testable end to end. The result is flagged `mock` and the UI says so.
 */
function mockTemplateStructure(prompt, category, kind) {
  const subject = kind || prompt.replace(/^\s*create\s+(an?|the)?\s*/i, "").trim() || "new document";
  const title = subject.replace(/\b\w/g, (c) => c.toUpperCase());

  const headings =
    category === "Education"
      ? ["Overview", "Learning objectives", "Instructions", "Assessment", "Resources"]
      : category === "Personal"
        ? ["Introduction", "Details", "Key points", "Notes", "Closing"]
        : ["Summary", "Background", "Scope", "Details", "Timeline", "Next steps"];

  const content =
    `<h1>${title}</h1>\n` +
    headings.map((h) => `<h2>${h}</h2>\n<p>{{${h.toLowerCase().replace(/\s+/g, "_")}}}</p>`).join("\n");

  const fields = headings.map((h) => ({
    name: h.toLowerCase().replace(/\s+/g, "_"),
    label: h,
    type: "textarea",
    hint: `Fill in the ${h.toLowerCase()}.`,
    required: true,
  }));

  return {
    title,
    description: `[mock provider] Skeleton for "${prompt}". Set OPENAI_API_KEY for a generated structure.`,
    category,
    content,
    fields,
    tags: ["smart", "ai", String(category).toLowerCase()],
  };
}

export { DOCUMENT_ACTIONS };

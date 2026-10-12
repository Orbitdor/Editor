"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  askAboutDocument,
  getAiStatus,
  getAiUsage,
  runAiAction,
} from "@/lib/api";

/**
 * AI side panel: writing assistant + document Q&A.
 *
 * The panel never writes to the document on its own. A result appears in an
 * editable preview and the user decides to replace the selection, insert it, or
 * discard it. That keeps the AI advisory instead of authoritative, which matters
 * for a document editor.
 */

/** Quick actions shown as buttons. Each maps to a backend AI action. */
const QUICK_ACTIONS = [
  { action: "improve", label: "Improve", hint: "Clearer wording" },
  { action: "fix-grammar", label: "Fix grammar", hint: "Spelling and punctuation" },
  { action: "rewrite", label: "Rewrite", hint: "Fresh wording" },
  { action: "professional", label: "Professional", hint: "Business register" },
  { action: "concise", label: "Shorten", hint: "Cut the filler" },
  { action: "expand", label: "Expand", hint: "Add detail" },
  { action: "summarize", label: "Summarize", hint: "Whole document" },
  { action: "key-points", label: "Key points", hint: "Bullet summary" },
  { action: "extract-tasks", label: "Extract tasks", hint: "Checklist of actions" },
];

const TONES = ["formal", "friendly", "confident", "concise", "persuasive"];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ur", label: "Urdu" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
];

/** True when the editor has a non-empty selection for the AI to work on. */
function hasSelection(selection) {
  return Boolean(selection && selection.trim().length > 0);
}

export default function AiPanel({
  documentId,
  /** Currently highlighted text, or "" when nothing is selected. */
  selection = "",
  /** Whether the caller may modify the document. */
  canEdit = true,
  /** Insert AI output at the current caret. */
  onInsert,
  /** Replace the current selection with AI output. */
  onReplace,
  onClose,
}) {
  const [status, setStatus] = useState(null);
  const [usage, setUsage] = useState(null);
  const [result, setResult] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [tone, setTone] = useState("formal");
  const [language, setLanguage] = useState("en");
  const [mock, setMock] = useState(false);
  const resultRef = useRef(null);

  // Load provider capability and quota once per document.
  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;

    (async () => {
      try {
        const [s, u] = await Promise.all([getAiStatus(), getAiUsage()]);
        if (cancelled) return;
        setStatus(s);
        setUsage(u);
      } catch {
        // A missing capability probe must not break the panel; actions report
        // their own errors when they are actually used.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Refetch the quota after a call so the header stays honest.
  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await getAiUsage());
    } catch {
      // Non-critical.
    }
  }, []);

  const run = useCallback(
    async (params) => {
      setBusy(params.action);
      setError("");
      try {
        const res = await runAiAction(documentId, {
          selection: hasSelection(selection) ? selection : undefined,
          ...params,
        });
        setResult(res.result || "");
        setDraft(res.result || "");
        setMock(Boolean(res.mock));
        refreshUsage();
      } catch (err) {
        setError(err.message || "The AI request failed");
        setResult("");
        setDraft("");
      } finally {
        setBusy("");
      }
    },
    [documentId, selection, refreshUsage]
  );

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    setBusy("ask");
    setError("");
    try {
      const res = await askAboutDocument(documentId, q, language);
      setResult(res.answer || "");
      setDraft(res.answer || "");
      setMock(Boolean(res.mock));
      setQuestion("");
      refreshUsage();
    } catch (err) {
      setError(err.message || "The question could not be answered");
    } finally {
      setBusy("");
    }
  }, [documentId, question, language, refreshUsage]);

  const selected = hasSelection(selection);
  const exhausted =
    usage && usage.day && usage.day.limit > 0 && usage.day.requests >= usage.day.limit;

  return (
    <aside className="flex h-full w-full flex-col border-l border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-800">AI Assistant</span>
          {mock && (
            <span
              title="No provider key is configured, so results are placeholders"
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
            >
              demo mode
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI panel"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            &times;
          </button>
        )}
      </header>

      {usage && (
        <div className="border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500">
          {usage.day.requests}/{usage.day.limit} AI requests today &middot;{" "}
          {usage.month.requests}/{usage.month.limit} this month
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {exhausted && (
          <p className="mb-3 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
            Daily AI limit reached. It resets tomorrow.
          </p>
        )}

        {/* Ask about the document */}
        <section className="mb-4">
          <label className="mb-1 block text-xs font-medium text-zinc-700" htmlFor="ai-question">
            Ask about this document
          </label>
          <div className="flex gap-1.5">
            <input
              id="ai-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) ask();
              }}
              placeholder="What are the main requirements?"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
            <button
              type="button"
              onClick={ask}
              disabled={busy || !question.trim()}
              className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy === "ask" ? "..." : "Ask"}
            </button>
          </div>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                Answer in {l.label}
              </option>
            ))}
          </select>
        </section>

        {/* Writing actions */}
        <section className="mb-4">
          <p className="mb-1.5 text-xs font-medium text-zinc-700">
            {selected ? "Writing assistant" : "Document actions"}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.action}
                type="button"
                title={a.hint}
                disabled={busy || !canEdit}
                onClick={() =>
                  run(
                    a.action === "tone"
                      ? { action: a.action, tone }
                      : a.action === "translate"
                        ? { action: a.action, language }
                        : { action: a.action }
                  )
                }
                className={cn(
                  "rounded-md border border-zinc-200 px-2 py-1.5 text-left text-xs",
                  "hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-40"
                )}
              >
                {busy === a.action ? "Working..." : a.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-1.5">
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              disabled={busy || !canEdit}
              aria-label="Target tone"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
            >
              {TONES.map((t) => (
                <option key={t} value={t}>
                  Tone: {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !canEdit}
              onClick={() => run({ action: "tone", tone })}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40"
            >
              Apply tone
            </button>
          </div>

          <div className="mt-1.5 flex gap-1.5">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={busy || !canEdit}
              aria-label="Translate to"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  Translate to {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !canEdit}
              onClick={() => run({ action: "translate", language })}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40"
            >
              Translate
            </button>
          </div>

          {!canEdit && (
            <p className="mt-2 text-[11px] text-zinc-500">
              You have read-only access, so AI results cannot be inserted.
            </p>
          )}
        </section>

        {/* Result */}
        {(result || error) && (
          <section ref={resultRef} className="border-t border-zinc-200 pt-3">
            {error ? (
              <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
            ) : (
              <>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={8}
                  aria-label="AI result"
                  className="w-full resize-y rounded-md border border-zinc-300 p-2 text-xs leading-relaxed outline-none focus:border-zinc-500"
                />
                {canEdit && (
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => onReplace?.(draft)}
                      disabled={!selected}
                      title={selected ? "Replace the selected text" : "Select text first"}
                      className="flex-1 rounded-md bg-zinc-900 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                    >
                      Replace selection
                    </button>
                    <button
                      type="button"
                      onClick={() => onInsert?.(draft)}
                      className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs hover:bg-zinc-50"
                    >
                      Insert at cursor
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(draft)
                          .catch(() => setError("Copy failed. Select the text and copy it manually."));
                      }}
                      className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs hover:bg-zinc-50"
                    >
                      Copy
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>

      {status && !status.configured && (
        <footer className="border-t border-zinc-100 px-3 py-2 text-[10px] leading-relaxed text-zinc-400">
          No AI provider key is configured on the server, so results are placeholders. Set
          OPENAI_API_KEY in backend/.env to enable real results.
        </footer>
      )}
    </aside>
  );
}

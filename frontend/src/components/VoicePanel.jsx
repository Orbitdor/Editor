"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { finishDictation, getVoiceStatus, transcribeAudio } from "@/lib/api";
import {
  PROVIDERS,
  VOICE_LANGUAGES,
  pickProvider,
  startBrowserSpeech,
  startRecording,
  unsupportedReason,
} from "@/lib/speech";

/**
 * Voice dictation panel (master plan sections 15-18).
 *
 * Two modes, chosen automatically from browser support:
 *
 *   - `browser`: the Web Speech API transcribes live as the user speaks. The
 *     audio never leaves the device, but the text arrives unpunctuated.
 *   - `server`: audio is recorded and uploaded for transcription. Works in every
 *     browser, costs provider minutes, and needs a configured key.
 *
 * Either way the transcript goes to the server for cleanup, so punctuation,
 * paragraph breaks, language detection and spoken commands behave the same in
 * both modes. Nothing is inserted into the document until the user confirms, and
 * the raw transcript is always shown next to the cleaned text so an over-eager
 * cleanup can never silently change someone's words.
 */

/** How the result should be placed. Mirrors the AI panel's choices. */
const PLACEHOLDER_IDLE = "Start speaking to see your text here.";

export default function VoicePanel({
  documentId,
  /** Whether the caller may modify the document. */
  canEdit = true,
  /** Insert the final text at the current caret. */
  onInsert,
  /** Spoken command handlers, keyed by command id. */
  onCommand,
  onClose,
}) {
  const [status, setStatus] = useState(null);
  const [provider, setProvider] = useState(PROVIDERS.NONE);
  const [language, setLanguage] = useState("auto");
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState("");
  const [result, setResult] = useState(null);
  const [draft, setDraft] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  // The active capture session. Kept in a ref so unmounting mid-recording can
  // tear the microphone down without a stale closure.
  const sessionRef = useRef(null);
  const timerRef = useRef(null);
  // `start` needs to be able to end a recording that hits the time limit, but
  // `stop` is declared after it. The ref breaks that ordering without the
  // stale-closure risk a dependency would introduce.
  const stopRef = useRef(null);

  /** Stop the timer and release the microphone. */
  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    sessionRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Release the mic if the panel closes while recording.
      try {
        sessionRef.current?.cancel?.();
      } catch {
        // Nothing useful to do if teardown fails.
      }
    };
  }, []);

  // Probe the backend once: it decides the provider and shows the quota.
  useEffect(() => {
    let cancelled = false;
    getVoiceStatus()
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        setProvider(pickProvider(data));
      })
      .catch(() => {
        if (cancelled) return;
        setStatus(null);
        setProvider(pickProvider({}));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const maxSeconds = status?.maxClipSeconds || 120;

  /** Ask the server to clean a transcript and extract spoken commands. */
  const clean = useCallback(
    async (transcript, seconds) => {
      setBusy(true);
      setError("");
      try {
        const data = await finishDictation(documentId, transcript, {
          language,
          durationSeconds: seconds,
        });
        setResult(data);
        setDraft(data.text || "");
        // Commands are applied to the editor before the text is inserted, so a
        // "make this a heading" affects the block the text lands in.
        for (const command of data.commands || []) {
          onCommand?.(command.id);
        }
        // Refresh the remaining minutes in the header.
        getVoiceStatus().then(setStatus).catch(() => {});
      } catch (err) {
        setError(err.message);
        // Fall back to the raw transcript so the words are never lost.
        setResult({ rawTranscript: transcript, text: transcript, commands: [] });
        setDraft(transcript);
      } finally {
        setBusy(false);
      }
    },
    [documentId, language, onCommand]
  );

  const start = useCallback(async () => {
    setError("");
    setResult(null);
    setDraft("");
    setLive("");
    setElapsed(0);
    setBusy(true);

    try {
      if (provider === PROVIDERS.BROWSER) {
        const session = startBrowserSpeech({
          language,
          onPartial: (text) => setLive(text),
        });
        sessionRef.current = session;
        setListening(true);
      } else if (provider === PROVIDERS.SERVER) {
        const session = await startRecording({ onLevel: setLevel, maxSeconds });
        sessionRef.current = session;
        setListening(true);
      } else {
        throw new Error(unsupportedReason() || "Voice input is unavailable in this browser");
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
      teardown();
      return;
    }

    setBusy(false);
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      // The clip hit the server's limit, so end it and process what we have.
      if (seconds >= maxSeconds) stopRef.current?.();
    }, 250);
  }, [provider, language, maxSeconds, teardown]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      teardown();
      setListening(false);
      return;
    }

    const seconds = elapsed;
    teardown();
    setListening(false);
    setBusy(true);

    try {
      if (provider === PROVIDERS.BROWSER) {
        // The recognition promise resolves with the finalised transcript.
        const { transcript } = await session.promise;
        setLive("");
        if (!transcript.trim()) {
          setError("Nothing was heard. Check the microphone and try again.");
          return;
        }
        await clean(transcript, seconds);
      } else {
        const { dataUrl, seconds: recordedSeconds } = await session.stop();
        setLive("");
        const data = await transcribeAudio(documentId, dataUrl, {
          language,
          durationSeconds: recordedSeconds,
        });
        setResult(data);
        setDraft(data.text || "");
        for (const command of data.commands || []) {
          onCommand?.(command.id);
        }
        getVoiceStatus().then(setStatus).catch(() => {});
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [elapsed, provider, documentId, language, clean, onCommand, teardown]);

  const cancel = useCallback(() => {
    try {
      sessionRef.current?.cancel?.();
    } catch {
      // Already released.
    }
    teardown();
    setListening(false);
    setBusy(false);
    setLive("");
    setElapsed(0);
  }, [teardown]);

  // Publish `stop` for the clip-length timer to call.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => () => {
    stopRef.current = null;
  }, []);

  const insert = () => {
    const text = draft.trim();
    if (!text) return;
    onInsert?.(text);
    setResult(null);
    setDraft("");
  };

  const commands = result?.commands || [];
  const hasResult = Boolean(result);

  return (
    <aside className="flex h-full min-h-0 flex-col border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Dictation</h2>
          <p className="text-xs text-zinc-500">
            {provider === PROVIDERS.BROWSER
              ? "Transcribed in your browser"
              : provider === PROVIDERS.SERVER
                ? "Audio sent for transcription"
                : "Unavailable"}
            {status?.minutesRemainingToday !== undefined
              ? ` · ${status.minutesRemainingToday} min left today`
              : ""}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dictation"
            className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100"
          >
            ✕
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {!canEdit ? (
          <p className="rounded-md bg-zinc-50 p-3 text-xs text-zinc-600">
            You have read-only access, so dictation can be reviewed but not inserted.
          </p>
        ) : null}

        {provider === PROVIDERS.NONE ? (
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            {unsupportedReason() || "Voice input is unavailable in this browser."}
          </p>
        ) : null}

        {status?.mock ? (
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            No speech provider key is set on the server, so recorded audio returns a
            placeholder. Browser dictation still works.
          </p>
        ) : null}

        {/* Language picker */}
        <label className="block text-xs font-medium text-zinc-700">
          Spoken language
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={listening}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm font-normal"
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        {/* Record button */}
        <div className="flex flex-col items-center gap-3 py-2">
          <button
            type="button"
            onClick={listening ? stop : start}
            disabled={busy || provider === PROVIDERS.NONE}
            aria-pressed={listening}
            aria-label={listening ? "Stop dictation" : "Start dictation"}
            className={cn(
              "flex h-16 w-16 items-center justify-center rounded-full text-2xl transition",
              listening ? "bg-red-600 text-white" : "bg-zinc-900 text-white",
              (busy || provider === PROVIDERS.NONE) && "cursor-not-allowed opacity-40",
              !listening && !busy && provider !== PROVIDERS.NONE && "hover:bg-zinc-700"
            )}
          >
            {listening ? "■" : "●"}
          </button>

          {/* Amplitude meter while recording */}
          <div className="flex h-6 w-full items-center justify-center gap-0.5" aria-hidden="true">
            {listening
              ? Array.from({ length: 24 }, (_, i) => {
                  // A bar's height follows the measured level with a falloff, so
                  // the meter looks like a waveform rather than a flat block.
                  const distance = Math.abs(i - 12) / 12;
                  const height = Math.max(3, (1 - distance) * level * 22 + 3);
                  return (
                    <span
                      key={i}
                      className="w-0.5 rounded-full bg-zinc-800 transition-[height]"
                      style={{ height }}
                    />
                  );
                })
              : null}
          </div>

          <p className="text-xs tabular-nums text-zinc-500">
            {listening
              ? `Listening · ${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")} / ${maxSeconds}s`
              : busy
                ? "Working…"
                : "Tap to speak"}
          </p>

          {listening ? (
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50"
            >
              Cancel
            </button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        {/* Live transcript while speaking */}
        {listening && live ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <p className="mb-1 text-xs font-medium text-zinc-500">Hearing</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-800">{live}</p>
          </div>
        ) : null}

        {/* Result: cleaned text, reviewable before insertion */}
        {hasResult ? (
          <div className="space-y-3">
            {commands.length ? (
              <div className="rounded-md bg-emerald-50 p-3 text-xs text-emerald-800">
                Applied {commands.map((c) => c.id.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")}
              </div>
            ) : null}

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-500">Transcript</p>
                {result.rawTranscript ? (
                  <button
                    type="button"
                    onClick={() => setShowRaw((v) => !v)}
                    className="text-xs text-zinc-500 underline hover:text-zinc-800"
                  >
                    {showRaw ? "Hide what was heard" : "Show what was heard"}
                  </button>
                ) : null}
              </div>

              {showRaw ? (
                <p className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-xs text-zinc-600">
                  {result.rawTranscript}
                </p>
              ) : (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={7}
                  className="w-full resize-y rounded-md border border-zinc-300 p-3 text-sm"
                />
              )}
            </div>

            {result.detectedLanguage ? (
              <p className="text-xs text-zinc-500">
                Detected language: {result.languageName || result.detectedLanguage}
                {result.confidence ? ` (${result.confidence}%)` : ""}
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={insert}
                disabled={!canEdit || !draft.trim()}
                className="flex-1 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Insert at cursor
              </button>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setDraft("");
                }}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50"
              >
                Discard
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">{PLACEHOLDER_IDLE}</p>
        )}
      </div>
    </aside>
  );
}

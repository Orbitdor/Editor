"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fileToDataUrl, runOcr } from "@/lib/api";

/**
 * Image -> Text (OCR) dialog.
 *
 * The extracted text is always shown for review first. Nothing is inserted into
 * the document until the user picks a part of it, because OCR output is never
 * trustworthy enough to write silently.
 */

/** Upload ceiling enforced in the browser to avoid a pointless round trip. */
const MAX_BYTES = 5 * 1024 * 1024;

const LANGUAGES = [
  { code: "auto", label: "Auto detect" },
  { code: "en", label: "English" },
  { code: "ur", label: "Urdu" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
];

/** Human-readable byte size. */
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OcrDialog({ documentId, canEdit = true, onInsert, onClose }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [language, setLanguage] = useState("auto");
  const [text, setText] = useState("");
  const [meta, setMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const accept = useCallback(async (picked) => {
    setError("");
    setText("");
    setMeta(null);
    if (!picked) return;
    if (!picked.type?.startsWith("image/")) {
      setError("Please choose a PNG, JPEG, WebP or GIF image.");
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError(`That image is ${sizeLabel(picked.size)}. The limit is ${sizeLabel(MAX_BYTES)}.`);
      return;
    }
    setFile(picked);
    setPreview(URL.createObjectURL(picked));
  }, []);

  const extract = useCallback(async () => {
    if (!file || !documentId) return;
    setBusy(true);
    setError("");
    try {
      // Downscale + re-encode before upload: strips EXIF and keeps the payload
      // inside the server's body limit.
      const dataUrl = await fileToDataUrl(file);
      const res = await runOcr(documentId, dataUrl, language);
      setText(res.text || "");
      setMeta({
        detectedLanguage: res.languageName || res.detectedLanguage,
        confidence: res.confidence,
        durationMs: res.durationMs,
        mock: res.mock,
        invoice: res.invoice,
        jobId: res.jobId,
      });
    } catch (err) {
      setError(err.message || "Text could not be extracted from that image");
    } finally {
      setBusy(false);
    }
  }, [file, documentId, language]);

  const insert = (value) => {
    onInsert?.(value);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-800">Image to Text (OCR)</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            &times;
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              accept(e.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center",
              dragging ? "border-zinc-500 bg-zinc-50" : "border-zinc-300 hover:border-zinc-400"
            )}
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Selected upload" className="max-h-40 rounded object-contain" />
            ) : (
              <>
                <span className="text-sm text-zinc-600">Drop an image here</span>
                <span className="text-xs text-zinc-400">or click to choose a file</span>
              </>
            )}
            <span className="mt-1 text-[11px] text-zinc-400">
              PNG, JPEG, WebP or GIF &middot; up to {sizeLabel(MAX_BYTES)}
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => accept(e.target.files?.[0])}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs text-zinc-600" htmlFor="ocr-language">
              Language
            </label>
            <select
              id="ocr-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={extract}
              disabled={!file || busy}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "Extracting..." : "Extract text"}
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
          )}

          {meta && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              <span className="rounded bg-zinc-100 px-1.5 py-0.5">
                Detected: {meta.detectedLanguage}
              </span>
              {meta.confidence > 0 && (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5">
                  Confidence: {meta.confidence}%
                </span>
              )}
              {meta.durationMs != null && (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5">{meta.durationMs} ms</span>
              )}
              {meta.mock && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">demo mode</span>
              )}
            </div>
          )}

          {/* Detected invoice fields, when the text looks like an invoice */}
          {meta?.invoice && (
            <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold text-zinc-700">Invoice fields detected</p>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-zinc-600">
                {Object.entries(meta.invoice)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-1">
                      <dt className="font-medium capitalize">{k}:</dt>
                      <dd className="truncate">{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          )}

          {text && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-zinc-700">Detected text</p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                aria-label="Detected text"
                className="w-full resize-y rounded-md border border-zinc-300 p-2 text-xs leading-relaxed outline-none focus:border-zinc-500"
              />
              <p className="mt-1 text-[11px] text-zinc-400">
                Review the text before inserting. OCR can misread characters.
              </p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50"
          >
            Close
          </button>
          {canEdit && text && (
            <>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(text)
                    .catch(() => setError("Copy failed. Select the text and copy it manually."));
                }}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => insert(text)}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white"
              >
                Insert into document
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

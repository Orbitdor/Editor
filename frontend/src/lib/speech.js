/**
 * Browser-side speech providers (master plan section 17).
 *
 * Two independent capabilities live here, and which one is used depends on what
 * the browser supports:
 *
 *   1. `MediaRecorder` captures audio. It works in every modern browser, and the
 *      clip can be uploaded to the server for real speech-to-text.
 *   2. `SpeechRecognition` transcribes in the browser. It is free, private and
 *      needs no key, but only exists in Chromium and Safari, and it returns
 *      unpunctuated text.
 *
 * `pickProvider` decides which path the UI should offer. Audio capture and
 * in-browser transcription are independent on purpose: a user in Firefox gets
 * server-side transcription, and one in Chrome can choose either.
 */

/** Providers this module can drive. */
export const PROVIDERS = {
  BROWSER: "browser",
  SERVER: "server",
  NONE: "none",
};

/** Languages offered in the dictation UI, matching the server's list. */
export const VOICE_LANGUAGES = [
  { value: "auto", label: "Auto detect" },
  { value: "en-US", label: "English (US)" },
  { value: "en-PK", label: "English (Pakistan)" },
  { value: "ur-PK", label: "Urdu" },
  { value: "ar-SA", label: "Arabic" },
  { value: "hi-IN", label: "Hindi" },
];

/** Spellings of the recognition API across vendors. */
const SpeechRecognitionImpl =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

/** True when this browser can transcribe without a server. */
export function supportsBrowserSpeech() {
  return Boolean(SpeechRecognitionImpl);
}

/** True when this browser can record audio. */
export function supportsRecording() {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/** True when the user has already granted microphone access. */
export function hasMicPermission() {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
  const result = navigator.permissions.query({ name: "microphone" });
  // The API is promise-based; callers treat "unknown" as "not yet decided".
  return result.catch(() => null);
}

/**
 * Decide which provider to offer.
 *
 * The server is preferred when the backend reports a configured provider,
 * because it is the only path that works outside Chromium. In-browser
 * recognition is the fallback.
 *
 * @param {{serverConfigured?: boolean}} status Response of `GET /voice/status`.
 */
export function pickProvider(status) {
  if (status?.serverConfigured && supportsRecording()) return PROVIDERS.SERVER;
  if (supportsBrowserSpeech()) return PROVIDERS.BROWSER;
  if (supportsRecording()) return PROVIDERS.SERVER;
  return PROVIDERS.NONE;
}

/** Human-readable reason the microphone is unavailable, or null when it is. */
export function unsupportedReason() {
  if (typeof window === "undefined") return "Voice input needs a browser.";
  if (supportsRecording() || supportsBrowserSpeech()) return null;
  if (!window.isSecureContext) {
    return "Microphone access needs HTTPS or localhost.";
  }
  return "This browser does not support speech input. Try Chrome, Edge or Safari.";
}

/** Pick a container the browser can actually record. */
function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

/**
 * Record audio with the microphone.
 *
 * The browser gives no live level readings for a raw stream, so a Web Audio
 * analyser drives the waveform. The callback receives a 0..1 value that the UI
 * can use for an animated meter.
 *
 * @param {object} opts
 * @param {string} opts.language BCP-47 code, or `auto`.
 * @param {(level: number) => void} [opts.onLevel] 0..1 amplitude.
 * @param {number} [opts.maxSeconds] Hard stop, mirrors the server's clip limit.
 * @returns {Promise<{stop: () => void, cancel: () => void}>}
 */
export async function startRecording({ onLevel, maxSeconds = 120 } = {}) {
  if (!supportsRecording()) {
    throw new Error(unsupportedReason() || "Recording is not supported in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];

  // Amplitude meter for the UI.
  let audioContext = null;
  let meterTimer = null;
  if (onLevel) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      meterTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) {
          const delta = (sample - 128) / 128;
          sum += delta * delta;
        }
        onLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 3));
      }, 100);
    } catch {
      // A meter is cosmetic; recording continues without it.
    }
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const teardown = () => {
    if (meterTimer) clearInterval(meterTimer);
    if (audioContext) audioContext.close().catch(() => {});
    stream.getTracks().forEach((track) => track.stop());
  };

  const stopTimer = setTimeout(() => recorder.stop(), maxSeconds * 1000);
  recorder.start();
  const startedAt = Date.now();

  const stop = () =>
    new Promise((resolve) => {
      recorder.onstop = async () => {
        clearTimeout(stopTimer);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const dataUrl = await blobToDataUrl(blob);
        teardown();
        // Real elapsed time, not the cap, so quota accounting is honest.
        resolve({
          dataUrl,
          mimeType: recorder.mimeType,
          seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        });
      };
      if (recorder.state !== "inactive") recorder.stop();
    });

  const cancel = () => {
    clearTimeout(stopTimer);
    if (recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    teardown();
  };

  return { stop, cancel, recorder, stream };
}

/** Read a recorded blob as a base64 data URL for the API. */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/**
 * Transcribe live in the browser.
 *
 * The result arrives as a growing string via `onPartial`, and the final
 * transcript via the promise. `continuous` is enabled so a paragraph is not cut
 * off at a short pause, and the engine is told not to add punctuation, because
 * the server's cleanup pipeline does that far more reliably than the browser.
 *
 * @param {object} opts
 * @param {string} opts.language BCP-47 code, or `auto`.
 * @param {(text: string, isFinal: boolean) => void} opts.onPartial
 * @returns {Promise<{transcript: string, stop: () => void, cancel: () => void}>}
 */
export function startBrowserSpeech({ language = "auto", onPartial } = {}) {
  if (!SpeechRecognitionImpl) {
    throw new Error("This browser cannot transcribe speech. Use the upload option instead.");
  }

  const recognition = new SpeechRecognitionImpl();
  recognition.continuous = true;
  recognition.interimResults = true;
  // The server adds punctuation and paragraph breaks, so the browser should not
  // try and guess at them.
  recognition.maxAlternatives = 1;
  if (language && language !== "auto") recognition.lang = language;

  let finalText = "";
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += chunk;
        } else {
          interim += chunk;
        }
      }
      onPartial?.(finalText + interim, finalText.length > 0);
    };

    recognition.onerror = (event) => {
      settled = true;
      // `no-speech` and `aborted` are normal, not failures worth surfacing.
      if (event.error === "no-speech" || event.error === "aborted") {
        resolve({ transcript: finalText });
        return;
      }
      reject(new Error(describeRecognitionError(event.error)));
    };

    recognition.onend = () => {
      if (!settled) {
        settled = true;
        resolve({ transcript: finalText });
      }
    };
  });

  recognition.start();

  return {
    promise,
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
    },
    cancel: () => {
      settled = true;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    },
  };
}

/** Turn a raw `SpeechRecognition` error code into something a user can act on. */
function describeRecognitionError(code) {
  const messages = {
    "not-allowed": "Microphone permission was denied. Allow it in your browser settings.",
    "service-not-allowed": "The browser blocked the speech service. Try recording audio instead.",
    "audio-capture": "No microphone was found.",
    network: "The browser speech service is unreachable. Try recording audio instead.",
  };
  return messages[code] || `Speech recognition failed (${code}).`;
}

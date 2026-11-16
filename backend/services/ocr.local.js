import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "tesseract.js";
import { ApiError } from "../utils/ApiError.js";
import { extractLines, formatLines, isSettled, letterCount, mergePasses } from "./ocr.merge.js";
import { prepareImage } from "./ocr.image.js";

/**
 * Local OCR engine.
 *
 * This is the default image-to-text path so the feature works with no AI
 * provider, no API key and no per-request cost. It runs on this machine: the
 * neural models of PP-OCR through `onnxruntime`, and Tesseract.js as the second
 * opinion and the fallback. Both are real OCR engines (not language models).
 *
 * The engines ship as code but the models are downloaded on first use and then
 * cached on disk (see `CACHE_PATH` and `.paddle-cache`), so the first
 * extraction of a given script pays a one-time download and every later one is
 * fast.
 *
 * Reading a page well takes more than handing the picture to one model:
 *
 *   1. the neural models find the lines on the page and read them - see
 *      `ocr.paddle.js`
 *   2. a line they are not sure of is handed to Tesseract on its own, which is
 *      what keeps scripts the neural models were not trained on (Urdu written
 *      in Nastaliq) readable - see `readLine`
 *   3. when the neural models cannot run at all, the picture is prepared into
 *      three renderings (straightened, lit, thresholded) and every script of
 *      the page is read with its own Tesseract model, merging the readings line
 *      by line - see `ocr.image.js` and `ocr.merge.js`
 *   4. a page that is still weak is read again with the other renderings and
 *      with the other page segmentation modes, because a poster and a document
 *      want a different kind of look
 *   5. whatever still came out weak is read again, on its own, larger
 *
 * `OCR_ENGINE=tesseract` skips the neural models and runs the Tesseract cascade
 * alone.
 */

/**
 * The page segmentation mode the main read uses.
 *
 * Tesseract's own default is "assume a single uniform block of text" and that
 * is what reads a poster or a quotation correctly. The automatic mode, which
 * looks for columns and blocks, reads a document better but comes back empty
 * on a poster, so it is used as one of the extra attempts instead.
 */
const PAGE_MODE = 6;

/**
 * How long the whole cascade may run. A page that is still unreadable after
 * this is reported as it is; the request must not hang on it.
 */
const TIME_BUDGET_MS = Number(process.env.OCR_TIME_BUDGET_MS || 45000);

/**
 * App language code -> Tesseract traineddata code.
 */
const TESS_LANGS = {
  en: "eng",
  ur: "urd",
  ar: "ara",
  hi: "hin",
};

/**
 * Model files live here once downloaded. Must exist before the worker writes.
 * Anchored to the backend folder (not the working directory) so the cache stays
 * in one place no matter where the server was started from.
 */
const CACHE_PATH =
  process.env.OCR_CACHE_PATH ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".tesseract-cache");

/**
 * Optional local folder holding `<lang>.traineddata(.gz)` for offline installs.
 * When unset, models come from the public Tesseract data CDN.
 */
const LANG_PATH = process.env.OCR_LANG_PATH || undefined;

/**
 * Languages used for `auto`.
 *
 * `auto` no longer means "English only". Loading several models into one
 * worker makes them compete for every character, so a Latin page sprouts
 * spurious Arabic and Devanagari characters. Instead `auto` runs one pass per
 * model and merges the passes line by line (see `ocr.merge.js`), which keeps
 * each script in the hands of the model that reads it best.
 *
 * `OCR_LANGS_AUTO` narrows that set for deployments that only ever see one
 * script, e.g. `OCR_LANGS_AUTO=eng+urd`.
 */
function autoTessLangs() {
  const configured = process.env.OCR_LANGS_AUTO || "eng+urd+hin";
  return configured
    .split("+")
    .map((code) => code.trim())
    .filter(Boolean);
}

/**
 * Resolve the Tesseract language string for an app language code.
 *
 * @param {string} language `auto` or one of en/ur/ar/hi
 * @returns {string} e.g. `eng` or `eng+urd+ara+hin`
 */
function tessLangs(language) {
  if (!language || language === "auto") return autoTessLangs().join("+");
  const code = TESS_LANGS[language];
  if (!code) throw new ApiError(400, `Unsupported OCR language: ${language}`);
  return code;
}

/**
 * One worker per language set, reused across requests. tesseract.js serialises
 * jobs internally, so concurrent requests queue on the shared worker instead of
 * corrupting each other's recognition.
 */
const workers = new Map();

/**
 * Progress callbacks for in-flight recognitions, keyed by the jobId handed to
 * `worker.recognize`. tesseract.js configures the logger once per worker, so a
 * worker reused by several requests needs the id to route each event back to
 * the request that owns it (the logger message carry it as `userJobId`).
 */
const progressSinks = new Map();

function routeProgress({ userJobId, status, progress }) {
  const sink = userJobId && progressSinks.get(userJobId);
  if (sink) sink({ status, progress: typeof progress === "number" ? progress : 0 });
}

/**
 * Exclusive access to a worker.
 *
 * The page segmentation mode is a property of the worker, so two requests that
 * read the same language with different modes would fight over it. Every
 * recognition therefore takes the worker for itself, sets the mode it needs
 * and hands the worker back.
 */
const workerQueues = new Map();

function withWorker(langs, action) {
  const previous = workerQueues.get(langs) || Promise.resolve();
  const next = previous.then(action, action);
  workerQueues.set(
    langs,
    next.catch(() => {})
  );
  return next;
}

function getWorker(langs) {
  const existing = workers.get(langs);
  if (existing) return existing;

  fs.mkdirSync(CACHE_PATH, { recursive: true });

  const pending = createWorker(langs.split("+"), 1, {
    cachePath: CACHE_PATH,
    logger: routeProgress,
    ...(LANG_PATH ? { langPath: LANG_PATH } : {}),
  }).then(async (worker) => {
    // Keep the columns/whitespace of a screenshot instead of collapsing runs of
    // spaces, and tell Tesseract the resolution when the image carries none
    // (screen captures never do), which it otherwise assumes is 0 dpi.
    await worker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    return worker;
  });
  // A failed start (offline, no cache) must not poison the cache for the next
  // attempt, so drop it and let a later request try again.
  pending.catch(() => workers.delete(langs));
  workers.set(langs, pending);
  return pending;
}

/**
 * Run one recognition pass.
 *
 * @param {object} params
 * @param {string[]} params.langs the models to load
 * @param {Buffer} params.buffer the picture to read
 * @param {number} params.psm page segmentation mode
 * @param {string} params.jobId id that routes the progress events
 * @param {string} params.variant name of the rendering that is being read
 * @param {number} params.width width of the rendering
 * @param {number} params.height height of the rendering
 * @returns {Promise<{text: string, confidence: number, lines: Array}>}
 */
async function runPass({ langs, buffer, psm, jobId, variant, width, height }) {
  const data = await withWorker(langs.join("+"), async () => {
    const worker = await getWorker(langs.join("+"));
    await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    const { data: result } = await worker.recognize(buffer, {}, { text: true, blocks: true }, jobId);
    return result;
  });

  const lines = extractLines(resultBlocks(data)).map((line) => ({
    ...line,
    source: { langs, psm, variant, width, height },
  }));
  return { text: data.text || "", confidence: data.confidence || 0, lines };
}

/** Tesseract returns the blocks under `data.blocks`; be forgiving about it. */
function resultBlocks(data) {
  return data?.blocks || [];
}

/**
 * The Tesseract model that should read one line.
 *
 * When the caller named a language, that language is used. On `auto` the model
 * is chosen from the characters the other engine found on the line: a line of
 * Nastaliq comes back from the Arabic model as a couple of Arabic letters, so
 * the hint still shows the script even when the reading is wrong.
 *
 * @param {string} language `auto` or one of en/ur/ar/hi
 * @param {string} [hint] what the other engine read on the line
 * @returns {string} a Tesseract language code
 */
function lineLangs(language, hint = "") {
  if (language && language !== "auto") return tessLangs(language);
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(hint)) return "urd";
  if (/[\u0900-\u097F]/.test(hint)) return "hin";
  return "eng";
}

/**
 * When a model could not be started (no network on a cold cache, say), the
 * lines are not all made to wait for the same failure: the model is left alone
 * for a while and the readings of the neural models stand.
 */
const lineFallbackDown = new Map();
const LINE_FALLBACK_RETRY_MS = 30000;

/**
 * Read one line on its own.
 *
 * This is the second opinion the recognition models get: the page is cut into
 * lines by one engine and a line that engine is unsure of is handed to
 * Tesseract. That is what keeps Urdu (written in Nastaliq, which the Arabic
 * model does not know) readable while the other lines keep the sharper model.
 *
 * @param {object} params
 * @param {Buffer} params.data the pixels of the line, three bytes per pixel
 * @param {number} params.width
 * @param {number} params.height
 * @param {string} [params.language] `auto` or an app language code
 * @param {string} [params.hint] what the other engine read on the line
 * @returns {Promise<{text: string, confidence: number}|null>}
 */
export async function readLine({ data, width, height, language = "auto", hint = "" }) {
  if (!width || !height || !data?.length) return null;
  const langs = lineLangs(language, hint);

  const downUntil = lineFallbackDown.get(langs) || 0;
  if (Date.now() < downUntil) return null;

  let png;
  try {
    const { default: sharp } = await import("sharp");
    // The line arrives as blue, green, red (the order the other models want);
    // they are put back in the order the web and Tesseract use.
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = data[i * 3 + 2];
      rgb[i * 3 + 1] = data[i * 3 + 1];
      rgb[i * 3 + 2] = data[i * 3];
    }
    // A short line is enlarged so that the strokes of a small script survive.
    const pipeline = sharp(rgb, { raw: { width, height, channels: 3 } });
    png = await (height < 64 ? pipeline.resize({ height: 64, kernel: "lanczos3" }) : pipeline)
      .greyscale()
      .png()
      .toBuffer();
  } catch {
    return null;
  }

  try {
    const result = await withWorker(langs, async () => {
      const worker = await getWorker(langs);
      // One line of text: no page layout to look for.
      await worker.setParameters({ tessedit_pageseg_mode: "7" });
      const { data: reading } = await worker.recognize(png, {}, { text: true });
      return reading;
    });
    lineFallbackDown.delete(langs);
    const text = (result?.text || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { text, confidence: result.confidence || 0 };
  } catch {
    lineFallbackDown.set(langs, Date.now() + LINE_FALLBACK_RETRY_MS);
    return null;
  }
}

/**
 * Which model read which script, and the order the passes run in.
 *
 * `auto` runs one pass per script family and merges them line by line (see
 * `ocr.merge.js`), because a page that mixes English and Urdu defeats any
 * single-model pass: the English model turns the Urdu into Latin gibberish and
 * the Urdu model turns the English into Arabic gibberish.
 */
function buildPasses(language) {
  if (language && language !== "auto") {
    const code = tessLangs(language);
    return [{ id: code, langs: [code] }];
  }
  return autoTessLangs().map((code) => ({ id: code, langs: [code] }));
}

/**
 * Cut a single line out of a rendering and enlarge it.
 *
 * A line that was read badly on the full page is often read well on its own:
 * the model no longer has to work out where the paragraph starts, and the
 * enlargement gives the small strokes enough pixels to survive.
 *
 * @param {Buffer} buffer the rendering
 * @param {object} bbox the line box in the rendering's coordinates
 * @param {number} width width of the rendering
 * @param {number} height height of the rendering
 * @returns {Promise<Buffer>} a PNG of the line
 */
async function cropLine(buffer, bbox, width, height) {
  const left = Math.max(0, Math.floor(bbox.x0) - 4);
  const top = Math.max(0, Math.floor(bbox.y0) - 4);
  const right = Math.min(width, Math.ceil(bbox.x1) + 4);
  const bottom = Math.min(height, Math.ceil(bbox.y1) + 4);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < 4 || cropHeight < 4) return null;

  const { default: sharp } = await import("sharp");
  const pipeline = sharp(buffer).extract({ left, top, width: cropWidth, height: cropHeight });
  // A very small crop cannot be scaled up with the high quality kernel, so it
  // is only enlarged when there is enough to enlarge. Twice the size is the
  // point where the strokes of a small script read best; more than that only
  // makes the engine slower and less sure.
  const enlarged = cropWidth * 2 >= 64 ? pipeline.resize({ width: cropWidth * 2, kernel: "lanczos3" }) : pipeline;
  return enlarged.greyscale().png().toBuffer();
}

/**
 * Read the weak lines of a result again, on their own.
 *
 * @param {object} merged the merged result
 * @param {Map<string, Buffer>} variants the renderings, by name
 * @param {string[]} fallbackLangs the model that read the page best
 * @param {string} jobId id that routes the progress events
 * @param {number} [deadline] timestamp after which no more lines are read
 * @returns {Promise<object>} the merged result, with the weak lines replaced
 */
async function refineWeakLines(merged, variants, fallbackLangs, jobId, deadline = Infinity) {
  const weak = merged.lines.filter((line) => line.confidence < 70).slice(0, 6);
  if (!weak.length) return merged;

  const lines = [...merged.lines];
  for (const line of weak) {
    if (Date.now() > deadline) break;
    const index = lines.indexOf(line);
    if (index < 0) continue;
    const source = line.source;
    if (!source) continue;
    const rendering = variants.get(source.variant);
    if (!rendering) continue;

    let crop;
    try {
      crop = await cropLine(rendering, line.bbox, source.width, source.height);
    } catch {
      continue;
    }
    if (!crop) continue;

    // The model that read the line, and the model that read the page best:
    // one of the two usually knows what the line is.
    const candidates = [source.langs, fallbackLangs].filter(
      (langs, i, all) => langs && all.findIndex((other) => other.join() === langs.join()) === i
    );

    for (const langs of candidates) {
      const result = await runPass({
        langs,
        buffer: crop,
        psm: 7,
        jobId,
        variant: `${source.variant}-line`,
        width: source.width,
        height: source.height,
      });
      const text = (result.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      // A line that is read on its own is worth taking when the engine is
      // surer of it, and also when it is about as sure but reads more letters
      // - a short answer of digits is the sign of a line it did not read.
      const surer = result.confidence > line.confidence + 1;
      const fuller =
        result.confidence > line.confidence - 2 && letterCount(text) > letterCount(line.text);
      if (surer || fuller) {
        lines[index] = { ...line, text, confidence: result.confidence, refined: true };
        break;
      }
    }
  }

  return { ...merged, text: formatLines(lines), lines };
}

/**
 * Read the page with the neural models, if they are available.
 *
 * The PP-OCR models find the lines and read them; a line they are not sure of
 * is handed to Tesseract (`readLine`). That combination is what the cascade
 * below cannot give: the models see the whole line at once, which is what a
 * page of mixed scripts needs, while Tesseract keeps the scripts the models
 * were not trained on (Urdu Nastaliq) readable.
 *
 * @param {object} params
 * @param {Buffer} params.image
 * @param {string} params.language
 * @param {(p: {status: string, progress: number}) => void} [params.onProgress]
 * @returns {Promise<object|null>} the result, or null when the models cannot run
 */
async function tryPaddle({ image, language, onProgress }) {
  if (process.env.OCR_ENGINE === "tesseract") return null;

  let extractTextWithPaddle;
  try {
    ({ extractTextWithPaddle } = await import("./ocr.paddle.js"));
  } catch {
    return null;
  }

  try {
    const result = await extractTextWithPaddle({
      image,
      language,
      onProgress,
      fallback: (crop) => readLine({ ...crop, language, hint: crop.text }),
    });
    if (!result.text.trim()) return null;
    return {
      text: result.text,
      confidence: result.confidence,
      mock: false,
      engine: "ppocr",
    };
  } catch {
    // A model that cannot be downloaded, a page the models cannot open: the
    // Tesseract cascade below still reads it.
    return null;
  }
}

/**
 * Extract text from an image with the local engine.
 *
 * With an explicit language a single model is used, which gives the best
 * result for a page written in that language. With `auto` one pass per script
 * family runs and the passes are merged line by line, so a page that mixes
 * English and Urdu comes out with both readable.
 *
 * @param {object} params
 * @param {Buffer} params.image the uploaded image
 * @param {string} [params.language] `auto` or an app language code
 * @param {(p: {status: string, progress: number}) => void} [params.onProgress]
 *   called with engine progress; `progress` is 0..1 for the current status
 * @returns {Promise<{text: string, mock: false, engine: string}>}
 */
export async function extractTextLocally({ image, language = "auto", onProgress }) {
  const neural = await tryPaddle({ image, language, onProgress });
  if (neural) return neural;

  const passes = buildPasses(language);

  // Loading the worker (and, on a cold cache, the language model) can be the
  // slowest part, so report it rather than sitting silently at 0%.
  onProgress?.({ status: "preparing image", progress: 0 });

  let prepared;
  try {
    prepared = await prepareImage(image);
  } catch (err) {
    throw new ApiError(400, `The image could not be prepared for reading (${err.message}).`);
  }
  const { variants, stats } = prepared;
  const renderings = new Map(variants.map((v) => [v.name, v.buffer]));

  const jobId = `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // The engine reports progress for the pass that is running; folding the
  // pass index into it keeps the bar moving steadily across all of them.
  let passIndex = 0;
  let passTotal = 1;
  if (onProgress) {
    progressSinks.set(jobId, ({ status, progress }) =>
      onProgress({ status, progress: (passIndex + progress) / passTotal })
    );
  }

  // A page that is this hard is not going to get better with more passes, and
  // the request must not hold the worker for ever.
  const deadline = Date.now() + TIME_BUDGET_MS;

  try {
    const results = [];
    const pool = [];

    /** Read the page with one rendering, one model and one page mode. */
    const read = async ({ langs, variant, psm }) => {
      const rendering = variants.find((v) => v.name === variant);
      if (!rendering) return null;
      const result = await runPass({
        langs,
        buffer: rendering.buffer,
        psm,
        jobId,
        variant: rendering.name,
        width: stats.width,
        height: stats.height,
      });
      results.push(result);
      pool.push(result.lines);
      return result;
    };

    // The first sweep: one pass per script family, on the hard rendering.
    // Page mode 6 reads the page as one block of text, which is what a poster
    // or a quotation needs; the automatic mode is tried further down, because
    // it is the one that reads a page with columns.
    passTotal = passes.length;
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      passIndex = i;
      await read({ langs: pass.langs, variant: variants[0].name, psm: PAGE_MODE });
      // The page is settled when every line came back confident.
      if (isSettled(mergePasses(pool))) break;
    }

    let merged = mergePasses(pool);
    const best = results.reduce((a, b) => (b.confidence > a.confidence ? b : a), results[0]);
    const bestLangs = best?.lines?.[0]?.source?.langs || passes[0].langs;
    const bestVariant = best?.lines?.[0]?.source?.variant || variants[0].name;

    // The other renderings: the same page, prepared differently. A picture
    // that the hard rendering cannot make sense of is often read perfectly by
    // the plain one, and small text likes the soft one.
    if (!isSettled(merged)) {
      for (const variant of variants.slice(1)) {
        if (Date.now() > deadline) break;
        passIndex = 0;
        passTotal = 1;
        await read({ langs: bestLangs, variant: variant.name, psm: PAGE_MODE });
        merged = mergePasses(pool);
        if (isSettled(merged)) break;
      }
    }

    // Another way of looking at the page. The automatic mode finds the columns
    // and the blocks of a document, the sparse mode finds text scattered over
    // a poster, and the column mode reads a page of prose.
    if (!isSettled(merged)) {
      for (const psm of [3, 11, 4]) {
        if (Date.now() > deadline) break;
        passIndex = 0;
        passTotal = 1;
        await read({ langs: bestLangs, variant: bestVariant, psm });
        merged = mergePasses(pool);
        if (isSettled(merged)) break;
      }
    }

    // Whatever is still weak is read again on its own, larger.
    passIndex = 0;
    passTotal = 1;
    merged = await refineWeakLines(merged, renderings, bestLangs, jobId, deadline);

    onProgress?.({ status: "recognizing text", progress: 1 });

    return {
      text: merged.text,
      confidence: merged.confidence,
      mock: false,
      engine: "tesseract",
      skew: stats.skew,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, `The text could not be extracted (${err.message}).`);
  } finally {
    progressSinks.delete(jobId);
  }
}

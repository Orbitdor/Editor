/**
 * PP-OCR (PaddleOCR) engine, running the published ONNX models in process.
 *
 * This is the engine a serious document product uses: the same model family
 * PaddleOCR ships, exported to ONNX so it runs inside the Node backend with
 * no Python and no external service.
 *
 * The pipeline is the one PaddleOCR uses, in three steps:
 *
 *   1. detection - a differentiable binarisation network (DB) finds where the
 *      text is on the page, whatever the layout, the font or the lighting
 *   2. orientation - a small classifier turns a line that is upside down the
 *      right way up
 *   3. recognition - a CRNN with a CTC head reads every box, and a model per
 *      script family keeps each script in the hands of the model that reads
 *      it best
 *
 * Every model is downloaded once and kept in `.paddle-cache`, the same way
 * the Tesseract models are kept in `.tesseract-cache`.
 *
 * The models are the mobile ones: they are small enough to keep in a server
 * container and fast enough to read a page in well under a second.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { estimateSkew, sauvolaBinarize } from "./ocr.image.js";
import { letterCount, countScripts } from "./ocr.merge.js";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

/**
 * Where the models live. ModelScope hosts the ONNX exports of PP-OCR; the
 * character lists come from the PaddleOCR repository itself, so a model and
 * its alphabet are always the pair the model was trained with.
 */
const MODEL_BASE =
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5";
const DICT_BASE =
  "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict";

/**
 * The models this engine knows.
 *
 * The `rec` models are listed per script family. The Arabic and the
 * Devanagari models carry the Latin letters as well, so a page that mixes
 * Urdu and English is read by one model.
 */
const MODELS = {
  det: {
    file: "det.onnx",
    url: `${MODEL_BASE}/det/ch_PP-OCRv5_det_mobile.onnx`,
  },
  cls: {
    file: "cls.onnx",
    url: `${MODEL_BASE}/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx`,
  },
  en: {
    file: "rec-en.onnx",
    dict: "ppocrv5_en_dict.txt",
    url: `${MODEL_BASE}/rec/en_PP-OCRv5_rec_mobile.onnx`,
  },
  latin: {
    file: "rec-latin.onnx",
    dict: "ppocrv5_latin_dict.txt",
    url: `${MODEL_BASE}/rec/latin_PP-OCRv5_rec_mobile.onnx`,
  },
  arabic: {
    file: "rec-arabic.onnx",
    dict: "ppocrv5_arabic_dict.txt",
    url: `${MODEL_BASE}/rec/arabic_PP-OCRv5_rec_mobile.onnx`,
  },
  devanagari: {
    file: "rec-devanagari.onnx",
    dict: "ppocrv5_devanagari_dict.txt",
    url: `${MODEL_BASE}/rec/devanagari_PP-OCRv5_rec_mobile.onnx`,
  },
};

/**
 * The recognition models to use, per language.
 *
 * With `auto` every script family is tried on every box and the one that is
 * surest of itself wins, which is what a page of mixed scripts needs.
 */
const REC_MODELS = {
  en: ["en", "latin"],
  ur: ["arabic"],
  ar: ["arabic"],
  hi: ["devanagari"],
  auto: ["arabic", "devanagari", "latin"],
};

/**
 * Models live here once downloaded. Anchored to the backend folder so the
 * cache stays in one place no matter where the server was started from.
 */
const CACHE_PATH =
  process.env.OCR_PADDLE_CACHE_PATH ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".paddle-cache");

/**
 * Detection settings, the ones the model was trained with.
 *
 * The detection model is the one model of the three that is normalised with
 * the ImageNet statistics rather than with 0.5; feeding it 0.5 weakens the
 * map until a line breaks into one blob per letter.
 */
const DET = {
  limitSideLen: 960, // the long side of the page is read at this size
  limitType: "max", // the long side is shrunk, a page is never blown up
  mean: [0.485, 0.456, 0.406], // per channel, in blue-green-red order
  std: [0.229, 0.224, 0.225],
  threshold: 0.3, // the map is cut here
  boxThreshold: 0.5, // a box needs this much confidence
  unclipRatio: 1.6, // how far a box grows around the ink
  minSize: 3, // a box smaller than this is not text
};

/** Recognition settings, the ones the model was trained with. */
const REC = {
  height: 48,
  width: 320,
};

/** Orientation settings, the ones the model was trained with. */
const CLS = {
  height: 48,
  width: 192,
  threshold: 0.9,
};

let ort = null;

/** Load ONNX Runtime once, on first use. */
async function runtime() {
  if (!ort) ort = require("onnxruntime-node");
  return ort;
}

/**
 * Download a file into the cache, unless it is already there.
 *
 * @param {string} name the file name inside the cache
 * @param {string} url where to get it
 * @returns {Promise<string>} the path of the cached file
 */
async function ensureFile(name, url) {
  const target = path.join(CACHE_PATH, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  fs.mkdirSync(CACHE_PATH, { recursive: true });
  const temporary = `${target}.download`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${name} (${response.status})`);
  const body = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, target);
  return target;
}

const sessions = new Map();
const dictionaries = new Map();

/**
 * The alphabet a model was trained with, read from the model itself.
 *
 * PaddleOCR writes the character list into the model when it exports it, so
 * the letters and the model can never drift apart. The list is stored in the
 * model's own notes, which are a few kilobytes at the end of the file.
 *
 * @param {string} file the path of the model
 * @returns {string[]|null} the characters, without the blank and the space
 */
function readEmbeddedCharacters(file) {
  try {
    const buffer = fs.readFileSync(file);
    const key = Buffer.from("character");
    const at = buffer.indexOf(key);
    if (at < 0) return null;

    // The value follows the name: a tag, the length of the text, the text.
    let cursor = at + key.length;
    if (buffer[cursor] !== 0x12) return null;
    cursor++;
    let length = 0;
    let shift = 0;
    let byte;
    do {
      byte = buffer[cursor++];
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);

    const text = buffer.slice(cursor, cursor + length).toString("utf8");
    const characters = text.split("\n").filter((line) => line.length > 0);
    return characters.length ? characters : null;
  } catch {
    return null;
  }
}

/**
 * The ONNX session of a model, created on first use and kept afterwards.
 *
 * @param {string} key one of the keys of `MODELS`
 * @returns {Promise<{session: object, dict: string[]}>}
 */
async function getModel(key) {
  if (sessions.has(key)) return sessions.get(key);
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown model: ${key}`);

  const pending = (async () => {
    const ort = await runtime();
    const modelPath = await ensureFile(model.file, model.url);
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });

    // The blank comes first and the space last, exactly as the model expects.
    let characters = readEmbeddedCharacters(modelPath);
    if (!characters && model.dict) {
      const dictPath = await ensureFile(model.dict, `${DICT_BASE}/${model.dict}`);
      if (!dictionaries.has(model.dict)) {
        dictionaries.set(
          model.dict,
          fs
            .readFileSync(dictPath, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.length > 0)
        );
      }
      characters = dictionaries.get(model.dict);
    }
    const dict = characters ? ["blank", ...characters, " "] : null;
    return { session, dict };
  })();

  sessions.set(key, pending);
  pending.catch(() => sessions.delete(key));
  return pending;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * Read the page into a plain buffer of blue, green and red bytes.
 *
 * The models were trained on the colour order of the training pipeline,
 * which is the reverse of the one the web uses.
 *
 * @param {Buffer} buffer the image
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 */
async function readBgr(buffer) {
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bgr = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < info.width * info.height; i++) {
    bgr[i * 3] = data[i * 3 + 2];
    bgr[i * 3 + 1] = data[i * 3 + 1];
    bgr[i * 3 + 2] = data[i * 3];
  }
  return { data: bgr, width: info.width, height: info.height };
}

/**
 * Measure the tilt of the page.
 *
 * The models read a straight page best, and the tilt of a page is easy to
 * measure: the picture is reduced to a small grey copy and the angle at which
 * the text lines line up is found (see `estimateSkew`).
 *
 * The copy is taken from the page that has already been decoded, so measuring
 * costs no second decode of the upload.
 *
 * @param {object} page the decoded page
 * @returns {number} the tilt in degrees
 */
function pageSkew(page) {
  const width = Math.min(600, page.width);
  const height = Math.max(1, Math.round((page.height * width) / page.width));
  const grey = new Uint8ClampedArray(width * height);
  const stepX = page.width / width;
  const stepY = page.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(page.height - 1, Math.floor(y * stepY));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(page.width - 1, Math.floor(x * stepX));
      const at = (sy * page.width + sx) * 3;
      // The page is blue, green, red; the tilt does not care about the order.
      grey[y * width + x] = (page.data[at] + page.data[at + 1] + page.data[at + 2]) / 3;
    }
  }
  const binary = sauvolaBinarize(grey, width, height, Math.max(8, Math.round(height / 30)));
  return estimateSkew(binary, width, height);
}

/**
 * Turn the decoded page by an angle, filling the corners with paper.
 *
 * @param {object} page the decoded page
 * @param {number} degrees
 * @returns {Promise<object>} the turned page
 */
async function rotatePage(page, degrees) {
  const { data, info } = await sharp(page.data, {
    raw: { width: page.width, height: page.height, channels: 3 },
  })
    .rotate(degrees, { background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

/**
 * Find the text boxes on the page.
 *
 * @param {Buffer} buffer the image
 * @returns {Promise<Array<{x0: number, y0: number, x1: number, y1: number, score: number}>>}
 */
export async function detectBoxes(page) {
  const { session } = await getModel("det");
  const { data, width, height } = page;

  // The long side of the page is read at `limitSideLen` and both sides are
  // rounded to a multiple of 32, which is what the network expects. A small
  // page is left as it is: blowing it up turns large text into text the
  // detection model no longer recognises.
  const long = Math.max(width, height);
  const ratio = long > DET.limitSideLen ? DET.limitSideLen / long : 1;
  const scaledWidth = Math.max(32, Math.round((width * ratio) / 32) * 32);
  const scaledHeight = Math.max(32, Math.round((height * ratio) / 32) * 32);

  const resized = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize(scaledWidth, scaledHeight, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();

  const plane = scaledWidth * scaledHeight;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (resized[i * 3] / 255 - DET.mean[0]) / DET.std[0];
    input[plane + i] = (resized[i * 3 + 1] / 255 - DET.mean[1]) / DET.std[1];
    input[2 * plane + i] = (resized[i * 3 + 2] / 255 - DET.mean[2]) / DET.std[2];
  }

  const ort = await runtime();
  const output = await session.run({
    x: new ort.Tensor("float32", input, [1, 3, scaledHeight, scaledWidth]),
  });
  const map = output[session.outputNames[0]];
  const dims = map.dims;
  const mapHeight = dims[dims.length - 2];
  const mapWidth = dims[dims.length - 1];
  const probability = map.data;

  return findBoxes(
    probability,
    mapWidth,
    mapHeight,
    width / mapWidth,
    height / mapHeight
  );
}

/**
 * Turn the detection map into boxes.
 *
 * The map says how likely it is that every small patch of the page holds
 * text. The patches above the threshold are grouped, every group is measured,
 * and the measurement is grown a little so that the box holds the whole
 * glyphs and not only their cores.
 *
 * @param {Float32Array} probability the detection map
 * @param {number} mapWidth
 * @param {number} mapHeight
 * @param {number} scaleX map pixels -> page pixels
 * @param {number} scaleY map pixels -> page pixels
 * @returns {Array<{x0: number, y0: number, x1: number, y1: number, score: number}>}
 */
function findBoxes(probability, mapWidth, mapHeight, scaleX, scaleY) {
  // The patches that hold text, a little thicker so that letters that stand
  // close together are read as one piece of text.
  const mask = new Uint8Array(mapWidth * mapHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = probability[i] > DET.threshold ? 1 : 0;
  const grown = new Uint8Array(mask.length);
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const index = y * mapWidth + x;
      let value = mask[index];
      if (x + 1 < mapWidth && mask[index + 1] > value) value = mask[index + 1];
      if (y + 1 < mapHeight) {
        if (mask[index + mapWidth] > value) value = mask[index + mapWidth];
        if (x + 1 < mapWidth && mask[index + mapWidth + 1] > value) value = mask[index + mapWidth + 1];
      }
      grown[index] = value;
    }
  }

  const labels = new Int32Array(mapWidth * mapHeight).fill(-1);
  const stack = [];
  const boxes = [];
  let label = 0;

  for (let start = 0; start < grown.length; start++) {
    if (labels[start] !== -1) continue;
    if (!grown[start]) {
      labels[start] = -2;
      continue;
    }

    // Walk the whole group of neighbouring patches.
    const pixels = [];
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const index = stack.pop();
      pixels.push(index);
      const x = index % mapWidth;
      const y = (index - x) / mapWidth;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= mapWidth || ny >= mapHeight) continue;
          const neighbour = ny * mapWidth + nx;
          if (labels[neighbour] !== -1) continue;
          if (!grown[neighbour]) {
            labels[neighbour] = -2;
            continue;
          }
          labels[neighbour] = label;
          stack.push(neighbour);
        }
      }
    }
    label++;

    if (pixels.length < DET.minSize) continue;

    // The smallest rectangle that holds the group.
    const rect = smallestRectangle(pixels, mapWidth);
    if (!rect) continue;

    const [topLeft, topRight, bottomRight, bottomLeft] = rect;
    const boxWidth = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
    const boxHeight = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
    if (boxWidth < DET.minSize || boxHeight < DET.minSize) continue;

    // The score of the box: how much of it is really text.
    const score = polygonScore(probability, mapWidth, mapHeight, rect);
    if (score < DET.boxThreshold) continue;

    // Grow the box around the ink, the way the model was trained to.
    const perimeter = 2 * (boxWidth + boxHeight);
    const growth = (boxWidth * boxHeight * DET.unclipRatio) / perimeter;

    const centreX = (topLeft[0] + bottomRight[0]) / 2;
    const centreY = (topLeft[1] + bottomRight[1]) / 2;
    const angle = Math.atan2(topRight[1] - topLeft[1], topRight[0] - topLeft[0]);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfWidth = boxWidth / 2 + growth;
    const halfHeight = boxHeight / 2 + growth;

    // The corners of the grown box, in the map's coordinates.
    const grownCorners = [];
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const lx = sx * halfWidth;
      const ly = sy * halfHeight;
      grownCorners.push([
        centreX + lx * cos - ly * sin,
        centreY + lx * sin + ly * cos,
      ]);
    }

    // Back to the page.
    const page = grownCorners.map(([x, y]) => [x * scaleX, y * scaleY]);
    const xs = page.map((point) => point[0]);
    const ys = page.map((point) => point[1]);
    boxes.push({
      x0: Math.max(0, Math.min(...xs)),
      y0: Math.max(0, Math.min(...ys)),
      x1: Math.min(scaleX * mapWidth, Math.max(...xs)),
      y1: Math.min(scaleY * mapHeight, Math.max(...ys)),
      score,
    });
  }

  return mergeLines(boxes);
}

/**
 * Join the pieces of a line into whole lines.
 *
 * On a small page the map often splits a line into a blob per word, or even
 * per letter, because the gaps between the letters are large compared to the
 * text. A recognition model reads a whole line best and a fragment worst, so
 * the pieces that sit on one line and stand close together are joined.
 *
 * @param {Array<{x0: number, y0: number, x1: number, y1: number, score: number}>} boxes
 * @returns {Array<{x0: number, y0: number, x1: number, y1: number, score: number}>}
 */
function mergeLines(boxes) {
  const pending = boxes.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];

  for (const box of pending) {
    const height = box.y1 - box.y0;
    let line = null;
    for (const candidate of lines) {
      const candidateHeight = candidate.y1 - candidate.y0;
      const shorter = Math.min(height, candidateHeight);
      const overlap = Math.min(box.y1, candidate.y1) - Math.max(box.y0, candidate.y0);
      if (overlap < shorter * 0.6) continue;

      // The gap between the two, in text heights; a negative gap means they
      // overlap, which is what the pieces of one line do.
      const gap = Math.max(box.x0, candidate.x0) - Math.min(box.x1, candidate.x1);
      if (gap > shorter * 1.2) continue;

      line = candidate;
      break;
    }

    if (!line) {
      lines.push({ ...box });
      continue;
    }

    line.x0 = Math.min(line.x0, box.x0);
    line.y0 = Math.min(line.y0, box.y0);
    line.x1 = Math.max(line.x1, box.x1);
    line.y1 = Math.max(line.y1, box.y1);
    line.score = Math.max(line.score, box.score);
  }

  return lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/**
 * The mean value of the map inside a shape.
 *
 * @param {Float32Array} probability the detection map
 * @param {number} mapWidth
 * @param {number} mapHeight
 * @param {Array<[number, number]>} shape the corners of the shape
 * @returns {number} the mean value, zero when the shape is empty
 */
function polygonScore(probability, mapWidth, mapHeight, shape) {
  const xs = shape.map((point) => point[0]);
  const ys = shape.map((point) => point[1]);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const right = Math.min(mapWidth - 1, Math.ceil(Math.max(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(mapHeight - 1, Math.ceil(Math.max(...ys)));

  let sum = 0;
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!insidePolygon(x + 0.5, y + 0.5, shape)) continue;
      sum += probability[y * mapWidth + x];
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Whether a point lies inside a shape.
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<[number, number]>} shape
 * @returns {boolean}
 */
function insidePolygon(x, y, shape) {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i];
    const [xj, yj] = shape[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * The smallest rectangle that holds a group of points.
 *
 * The convex hull of the group is built first, then every edge of the hull is
 * tried as a side of the rectangle, which is the classic way of finding it.
 *
 * @param {number[]} pixels the indexes of the group
 * @param {number} width the width of the map
 * @returns {Array<[number, number]>|null} the four corners
 */
function smallestRectangle(pixels, width) {
  const points = pixels.map((index) => {
    const x = index % width;
    return [x, (index - x) / width];
  });
  const hull = convexHull(points);
  if (hull.length < 3) return null;

  let best = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    const ux = dx / length;
    const uy = dy / length;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of hull) {
      const px = point[0] - a[0];
      const py = point[1] - a[1];
      const u = px * ux + py * uy;
      const v = -px * uy + py * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      best = [
        [a[0] + ux * minU, a[1] + uy * minU],
        [a[0] + ux * maxU, a[1] + uy * maxU],
        [a[0] + ux * maxU - uy * maxV, a[1] + uy * maxU + ux * maxV],
        [a[0] + ux * minU - uy * maxV, a[1] + uy * minU + ux * maxV],
      ];
    }
  }
  return best;
}

/**
 * The convex hull of a set of points (Andrew's monotone chain).
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const hull = [];
    for (const point of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
        hull.pop();
      }
      hull.push(point);
    }
    hull.pop();
    return hull;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/* ------------------------------------------------------------------ *
 * Recognition
 * ------------------------------------------------------------------ */

/**
 * Read one box of text.
 *
 * @param {{data: Buffer, width: number, height: number}} page the page
 * @param {object} box the box to read
 * @param {string[]} modelKeys the recognition models to try
 * @param {object} [options]
 * @param {number} [options.weakBelow] a reading below this score is weak
 * @param {(crop: {data: Buffer, width: number, height: number, text: string}) => Promise<{text: string, confidence: number}|null>} [options.fallback]
 *   a second engine that reads a weak line on its own
 * @returns {Promise<{text: string, score: number, model: string}>}
 */
export async function readBox(page, box, modelKeys, options = {}) {
  const crop = cutBox(page, box);
  if (!crop) return { text: "", score: 0, model: "" };

  const upright = await straighten(crop);
  const readings = [];
  for (const key of modelKeys) {
    const reading = await recognize(upright, key);
    if (reading.text) readings.push(reading);
  }

  // The model that is surest of itself wins the box.
  readings.sort((a, b) => b.score - a.score);
  const best = readings[0] || { text: "", score: 0, model: "" };

  // A script the models do not know well (Urdu is written in a hand the
  // Arabic model was not trained on) comes back as a weak reading, or as no
  // reading at all; the fallback engine gets a look at the same line.
  if (options.fallback && best.score < (options.weakBelow ?? 0.75)) {
    const alternative = await options.fallback({
      data: upright.data,
      width: upright.width,
      height: upright.height,
      text: readings.map((reading) => reading.text).join(" "),
    });
    if (alternative?.text) {
      const score = alternative.confidence / 100;
      // A surer reading wins outright. A fuller one wins too when it is not
      // obviously noise: a wrong script comes back as a couple of characters
      // while the right one comes back as a line of them.
      const fuller = letterCount(alternative.text) > letterCount(best.text);
      if (score > best.score || (fuller && score >= 0.4)) {
        return { text: alternative.text, score, model: "fallback" };
      }
    }
  }

  return best;
}

/**
 * Cut a box out of the page.
 *
 * @param {{data: Buffer, width: number, height: number}} page the page
 * @param {object} box the box to cut
 * @returns {{data: Buffer, width: number, height: number}|null} the cut
 */
function cutBox(page, box) {
  const left = Math.max(0, Math.floor(box.x0));
  const top = Math.max(0, Math.floor(box.y0));
  const right = Math.min(page.width, Math.ceil(box.x1));
  const bottom = Math.min(page.height, Math.ceil(box.y1));
  const width = right - left;
  const height = bottom - top;
  if (width < 4 || height < 4) return null;

  const data = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) {
    const source = ((top + y) * page.width + left) * 3;
    page.data.copy(data, y * width * 3, source, source + width * 3);
  }
  return { data, width, height };
}

/**
 * Turn a line that is upside down the right way up.
 *
 * @param {{data: Buffer, width: number, height: number}} crop the line
 * @returns {Promise<{data: Buffer, width: number, height: number}>} the line, upright
 */
async function straighten(crop) {
  try {
    const { session } = await getModel("cls");
    const ratio = crop.width / Math.max(1, crop.height);
    const resizedWidth = Math.min(CLS.width, Math.ceil(CLS.height * ratio));
    const resized = await sharp(crop.data, {
      raw: { width: crop.width, height: crop.height, channels: 3 },
    })
      .resize(resizedWidth, CLS.height, { fit: "fill", kernel: "lanczos3" })
      .raw()
      .toBuffer();

    const plane = CLS.width * CLS.height;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const source = i < resizedWidth * CLS.height ? i : -1;
      const b = source >= 0 ? resized[source * 3] / 255 : 0.5;
      const g = source >= 0 ? resized[source * 3 + 1] / 255 : 0.5;
      const r = source >= 0 ? resized[source * 3 + 2] / 255 : 0.5;
      input[i] = (b - 0.5) / 0.5;
      input[plane + i] = (g - 0.5) / 0.5;
      input[2 * plane + i] = (r - 0.5) / 0.5;
    }

    const ort = await runtime();
    const output = await session.run({
      x: new ort.Tensor("float32", input, [1, 3, CLS.height, CLS.width]),
    });
    const scores = output[session.outputNames[0]].data;
    // The two classes are "upright" and "upside down".
    if (scores[1] > CLS.threshold) {
      const turned = await sharp(crop.data, {
        raw: { width: crop.width, height: crop.height, channels: 3 },
      })
        .rotate(180)
        .raw()
        .toBuffer();
      return { data: turned, width: crop.width, height: crop.height };
    }
  } catch {
    // The classifier is a helper, not a must: a page that it cannot judge is
    // read as it is.
  }
  return crop;
}

/**
 * Read a line with one recognition model.
 *
 * @param {{data: Buffer, width: number, height: number}} crop the line
 * @param {string} key the model to use
 * @returns {Promise<{text: string, score: number, model: string}>}
 */async function recognize(crop, key) {
  const { session, dict } = await getModel(key);

  // The line is read at a fixed height. A wide line is given a wider canvas
  // so that it keeps its shape, a narrow one is padded on the right.
  const ratio = crop.width / Math.max(1, crop.height);
  const canvasWidth = Math.max(
    REC.width,
    Math.floor(REC.height * Math.max(ratio, REC.width / REC.height))
  );
  const resizedWidth = Math.min(canvasWidth, Math.ceil(REC.height * ratio));

  const resized = await sharp(crop.data, {
    raw: { width: crop.width, height: crop.height, channels: 3 },
  })
    .resize(resizedWidth, REC.height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();

  const plane = canvasWidth * REC.height;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const source = i < resizedWidth * REC.height ? i : -1;
    const b = source >= 0 ? resized[source * 3] / 255 : 0.5;
    const g = source >= 0 ? resized[source * 3 + 1] / 255 : 0.5;
    const r = source >= 0 ? resized[source * 3 + 2] / 255 : 0.5;
    input[i] = (b - 0.5) / 0.5;
    input[plane + i] = (g - 0.5) / 0.5;
    input[2 * plane + i] = (r - 0.5) / 0.5;
  }

  const ort = await runtime();
  const output = await session.run({
    x: new ort.Tensor("float32", input, [1, 3, REC.height, canvasWidth]),
  });
  const prediction = output[session.outputNames[0]];
  const dims = prediction.dims;
  const steps = dims[dims.length - 2];
  const classes = dims[dims.length - 1];
  const values = prediction.data;

  // The best character of every step, then the repeats and the blanks removed.
  let text = "";
  const confidences = [];
  let previous = -1;
  for (let step = 0; step < steps; step++) {
    const row = step * classes;
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < classes; c++) {
      const value = values[row + c];
      if (value > bestScore) {
        bestScore = value;
        best = c;
      }
    }
    if (best !== previous && best !== 0 && best < dict.length) {
      text += dict[best];
      confidences.push(bestScore);
    }
    previous = best;
  }

  const score = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  return { text: toLogical(text.trim()), score, model: key };
}

/**
 * The characters of the right-to-left scripts.
 *
 * The recognition model walks the line from left to right, so for a
 * right-to-left script it hands back the words in the order the eye sees them,
 * which is the reverse of the order the text is written in. A document needs
 * the written order: the editor stores text as it is typed, and a line stored
 * backwards cannot be edited, searched or spoken.
 */
const RTL_CHAR = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LTR_RUN = /[A-Za-z0-9][A-Za-z0-9 .,:;'"+&%$#@_\-=/\\()[\]]*/g;

/**
 * Turn the text of a right-to-left line the right way round again.
 *
 * A line of a right-to-left script is read by the model from left to right,
 * which is the reverse of the order it is written in, so the whole line is
 * reversed and every run of Latin letters and digits is reversed back, because
 * those were already in the right order.
 *
 * The direction of a mixed line is decided by its letters: a line that is
 * mostly Latin is left as it is, because the paragraph it belongs to is a
 * left-to-right one. Resolving a single word of the other script inside such a
 * line needs the full bidirectional algorithm, which the editor does when it
 * displays the text.
 *
 * @param {string} text the text as the model read it
 * @returns {string} the text in written order
 */
function toLogical(text) {
  if (!RTL_CHAR.test(text)) return text;
  const { arabic, latin } = countScripts(text);
  if (latin > arabic) return text;
  const reversed = Array.from(text).reverse().join("");
  return reversed.replace(LTR_RUN, (run) => Array.from(run).reverse().join(""));
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * Read a whole page.
 *
 * @param {object} params
 * @param {Buffer} params.image the page
 * @param {string} [params.language] `auto` or an app language code
 * @param {(p: {status: string, progress: number}) => void} [params.onProgress]
 * @param {(crop: {data: Buffer, width: number, height: number, text: string}) => Promise<{text: string, confidence: number}|null>} [params.fallback]
 *   a second engine, tried on the lines this one is not sure of
 * @returns {Promise<{text: string, confidence: number, lines: Array, engine: string}>}
 */
export async function extractTextWithPaddle({ image, language = "auto", onProgress, fallback }) {
  const modelKeys = REC_MODELS[language] || REC_MODELS.auto;
  // Urdu is written in Nastaliq, which the Arabic model does not read, so even
  // a confident-looking reading of an Urdu page is treated as weak.
  const weakBelow = language === "ur" ? 0.9 : 0.75;
  onProgress?.({ status: "straightening the page", progress: 0.05 });

  let page = await readBgr(image);
  try {
    const skew = pageSkew(page);
    if (Math.abs(skew) >= 0.4) page = await rotatePage(page, -skew);
  } catch {
    // A page the tilt cannot be measured on is read as it is.
  }
  onProgress?.({ status: "finding the text", progress: 0.15 });

  const boxes = await detectBoxes(page);
  onProgress?.({ status: "reading the text", progress: 0.3 });
  if (!boxes.length) {
    return { text: "", confidence: 0, lines: [], engine: "ppocr" };
  }

  const readings = [];
  for (let i = 0; i < boxes.length; i++) {
    const reading = await readBox(page, boxes[i], modelKeys, { fallback, weakBelow });
    if (reading.text) {
      readings.push({
        text: reading.text,
        confidence: Math.round(reading.score * 100),
        bbox: {
          x0: boxes[i].x0,
          y0: boxes[i].y0,
          x1: boxes[i].x1,
          y1: boxes[i].y1,
        },
      });
    }
    onProgress?.({
      status: "reading the text",
      progress: 0.3 + (0.65 * (i + 1)) / boxes.length,
    });
  }

  const lines = joinRows(readings);
  const confidence = lines.length
    ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
    : 0;
  onProgress?.({ status: "reading the text", progress: 1 });

  return {
    text: lines.map((line) => line.text).join("\n"),
    confidence,
    lines,
    engine: "ppocr",
  };
}

/**
 * Put the boxes that sit on the same line together.
 *
 * @param {Array} readings
 * @returns {Array<{text: string, confidence: number, bbox: object}>}
 */
function joinRows(readings) {
  const sorted = [...readings].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rows = [];
  for (const reading of sorted) {
    const height = reading.bbox.y1 - reading.bbox.y0;
    const centre = (reading.bbox.y0 + reading.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.centre - centre) < Math.max(8, height * 0.6));
    if (row) {
      row.items.push(reading);
      row.centre = (row.centre * (row.items.length - 1) + centre) / row.items.length;
    } else {
      rows.push({ centre, items: [reading] });
    }
  }

  return rows
    .map((row) => {
      // A right-to-left line runs from the right edge, so its boxes are read
      // from there; a left-to-right line runs from the left.
      const { arabic, latin } = countScripts(row.items.map((item) => item.text).join(" "));
      const items =
        arabic > latin
          ? [...row.items].sort((a, b) => b.bbox.x0 - a.bbox.x0)
          : [...row.items].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
      const confidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
      const bbox = {
        x0: Math.min(...items.map((item) => item.bbox.x0)),
        y0: Math.min(...items.map((item) => item.bbox.y0)),
        x1: Math.max(...items.map((item) => item.bbox.x1)),
        y1: Math.max(...items.map((item) => item.bbox.y1)),
      };
      return { text, confidence, bbox };
    })
    .filter((line) => line.text);
}

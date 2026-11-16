/**
 * Image preparation for OCR.
 *
 * A raw photo of a poster is a bad input for an OCR engine: the page is
 * tilted, the light is uneven, the text is small and the background is noisy.
 * Professional OCR pipelines fix the picture *before* the engine ever sees it,
 * and that is what this module does.
 *
 * The steps, in the order they matter:
 *
 *   1. orientation    - honour the EXIF rotation of the photo
 *   2. scaling        - bring the page to a resolution the engine likes
 *   3. deskew         - straighten the text (measured, not guessed)
 *   4. illumination   - divide out the lighting gradient and the shadows
 *   5. contrast       - stretch the tones so the ink is black and the paper white
 *   6. denoise        - remove the speckle that survives the threshold
 *   7. binarisation   - Sauvola adaptive threshold, so the local paper colour
 *                       does not decide what counts as ink
 *
 * Two renderings come out of it, because no single one is right for every
 * page: a hard black-and-white one (best for posters, forms and clean scans)
 * and a soft greyscale one (best for photographs and small text).
 *
 * Everything is plain typed arrays so it can be reasoned about and tested
 * without running the engine.
 */

import sharp from "sharp";

/** Longest edge of the working image. Above this the engine gains nothing. */
const MAX_EDGE = 2000;
/** Shortest edge of the working image. Below this the glyphs are too small. */
const MIN_EDGE = 1400;
/** Ink is dark, paper is light. */
const INK = 0;
const PAPER = 255;

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

/** Clamp a number into the 0..255 range. */
function clamp8(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

/**
 * Summed-area table of a single channel image.
 *
 * One table per statistic: the mean of a window is then a lookup instead of a
 * loop, which is what keeps the adaptive threshold affordable on a full page.
 */
function integralImage(src, w, h) {
  const stride = w + 1;
  const table = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      table[(y + 1) * stride + (x + 1)] = table[y * stride + (x + 1)] + rowSum;
    }
  }
  return table;
}

/** Sum of a rectangle in a summed-area table. */
function rectSum(table, w, x0, y0, x1, y1) {
  const stride = w + 1;
  return (
    table[y1 * stride + x1] - table[y0 * stride + x1] - table[y1 * stride + x0] + table[y0 * stride + x0]
  );
}

/**
 * Box blur of a single channel image.
 *
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @param {number} radius
 * @returns {Float64Array} blurred values, same size as the input
 */
export function boxBlur(src, w, h, radius) {
  const out = new Float64Array(w * h);
  if (radius < 1) {
    for (let i = 0; i < out.length; i++) out[i] = src[i];
    return out;
  }
  const table = integralImage(src, w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      out[y * w + x] = rectSum(table, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tone and light
 * ------------------------------------------------------------------ */

/**
 * Flat-field correction: divide the picture by its own lighting.
 *
 * A photo of a page usually has a shadow on one side and a highlight on the
 * other. Dividing the grey value by a heavily blurred copy of the same image
 * leaves the ink and removes the lighting, so the threshold below no longer
 * has to guess what the paper colour is.
 *
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray}
 */
export function correctIllumination(src, w, h) {
  const radius = Math.max(8, Math.round(Math.min(w, h) / 12));
  const background = boxBlur(src, w, h, radius);
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) {
    const light = background[i];
    // A pixel that is its own background carries no information.
    if (light < 1) {
      out[i] = src[i];
      continue;
    }
    out[i] = clamp8((src[i] / light) * 255);
  }
  return out;
}

/**
 * Percentile contrast stretch.
 *
 * Clips the darkest and the brightest few percent of the tones and maps what
 * is left onto the full range, so faint ink becomes black and the paper
 * becomes white.
 *
 * @param {Uint8ClampedArray} src
 * @param {number} lowPct fraction of pixels treated as black
 * @param {number} highPct fraction of pixels treated as white
 * @returns {Uint8ClampedArray}
 */
export function stretchContrast(src, lowPct = 0.02, highPct = 0.98) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < src.length; i++) histogram[src[i]]++;
  const total = src.length;
  let low = 0;
  let high = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += histogram[v];
    if (acc >= total * lowPct) {
      low = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += histogram[v];
    if (acc >= total * (1 - highPct)) {
      high = v;
      break;
    }
  }
  if (high <= low) return src;
  const scale = 255 / (high - low);
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) out[i] = clamp8((src[i] - low) * scale);
  return out;
}

/**
 * 3x3 median filter.
 *
 * Removes the speckle of a photographed page while keeping the edges of the
 * glyphs, which a blur would round off.
 *
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray}
 */
export function medianFilter(src, w, h) {
  const out = new Uint8ClampedArray(src.length);
  const window = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          window[n++] = src[yy * w + xx];
        }
      }
      const slice = window.subarray(0, n);
      slice.sort();
      out[y * w + x] = slice[n >> 1];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Thresholding
 * ------------------------------------------------------------------ */

/**
 * Otsu's threshold: the value that best splits the tones in two.
 *
 * @param {Uint8ClampedArray} src
 * @returns {number} threshold in 0..255
 */
export function otsuThreshold(src) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < src.length; i++) histogram[src[i]]++;
  const total = src.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let v = 0; v < 256; v++) {
    weightBackground += histogram[v];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += v * histogram[v];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      best = v;
    }
  }
  return best;
}

/**
 * Sauvola adaptive threshold.
 *
 * The threshold is not a fixed grey level but a function of the local
 * statistics: in a window around the pixel, the ink is everything that is
 * darker than the local mean by a margin that depends on the local contrast.
 * That is what lets one threshold work on a page with a shadow on one side
 * and a highlight on the other.
 *
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @param {number} window radius of the window in pixels
 * @param {number} k sensitivity (0.2 is the usual value)
 * @returns {Uint8ClampedArray} 0 for ink, 255 for paper
 */
export function sauvolaBinarize(src, w, h, window = Math.max(15, Math.round(Math.min(w, h) / 30)), k = 0.2) {
  const sum = integralImage(src, w, h);
  const squares = new Float64Array(src.length);
  for (let i = 0; i < squares.length; i++) squares[i] = src[i] * src[i];
  const sumSq = integralImage(squares, w, h);
  const out = new Uint8ClampedArray(w * h);
  const R = 128;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - window);
    const y1 = Math.min(h, y + window + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - window);
      const x1 = Math.min(w, x + window + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = rectSum(sum, w, x0, y0, x1, y1) / area;
      const meanSq = rectSum(sumSq, w, x0, y0, x1, y1) / area;
      const variance = Math.max(0, meanSq - mean * mean);
      const deviation = Math.sqrt(variance);
      const threshold = mean * (1 + k * (deviation / R - 1));
      out[y * w + x] = src[y * w + x] < threshold ? INK : PAPER;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Estimate how much the page is tilted.
 *
 * The method is the classic one: shear the ink by a candidate angle, project
 * it onto the horizontal axis and measure how sharp the resulting bands are.
 * When the angle matches the tilt, the text lines fall on top of each other
 * and the projection turns into sharp spikes; at any other angle it smears
 * out. The angle with the sharpest projection wins.
 *
 * @param {Uint8ClampedArray} binary the binarised page
 * @param {number} w
 * @param {number} h
 * @param {number} maxAngle largest tilt to look for, in degrees
 * @returns {number} the tilt in degrees, positive means the text climbs
 */
export function estimateSkew(binary, w, h, maxAngle = 6) {
  const step = 0.5;
  const maxShear = Math.tan((maxAngle * Math.PI) / 180);
  const offset = Math.ceil(w * maxShear) + 1;
  const span = h + offset + 2;

  // Ink is worth nothing without text to align, so count it first.
  let ink = 0;
  for (let i = 0; i < binary.length; i++) if (binary[i] <= 127) ink++;
  if (ink < 50) return 0;

  let bestAngle = 0;
  let bestScore = -1;
  for (let angle = -maxAngle; angle <= maxAngle + 0.001; angle += step) {
    const shear = Math.tan((angle * Math.PI) / 180);
    const profile = new Float64Array(span);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (binary[y * w + x] > 127) continue;
        const row = Math.round(y - x * shear) + offset;
        if (row >= 0 && row < span) profile[row]++;
      }
    }
    // The text lands in as few rows as possible when the angle is right, so
    // the projection is at its most concentrated there.
    let score = 0;
    for (let i = 0; i < span; i++) score += profile[i] * profile[i];
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * Turn a grey page by an angle, filling the corners with paper.
 *
 * @param {Uint8ClampedArray} grey
 * @param {number} w
 * @param {number} h
 * @param {number} degrees
 * @returns {Promise<{data: Uint8ClampedArray, info: {width: number, height: number}}>}
 */
async function rotateGrey(grey, w, h, degrees) {
  const rotated = await sharp(Buffer.from(grey), { raw: { width: w, height: h, channels: 1 } })
    .rotate(degrees, { background: { r: 255, g: 255, b: 255 } })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(rotated.data), info: rotated.info };
}

/**
 * Turn an uploaded image into the renderings the engine should read.
 *
 * @param {Buffer} buffer the uploaded image (any format sharp understands)
 * @param {object} [options]
 * @param {number} [options.maxEdge]
 * @param {number} [options.minEdge]
 * @returns {Promise<{variants: Array<{name: string, buffer: Buffer}>, stats: object}>}
 */
export async function prepareImage(buffer, options = {}) {
  const maxEdge = options.maxEdge || MAX_EDGE;
  const minEdge = options.minEdge || MIN_EDGE;

  // `rotate()` with no argument applies the EXIF orientation of the photo.
  const base = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const sourceWidth = meta.width || 0;
  const sourceHeight = meta.height || 0;
  if (!sourceWidth || !sourceHeight) throw new Error("The image could not be read");

  // Scale to a resolution the engine likes, never enlarging beyond need.
  const longest = Math.max(sourceWidth, sourceHeight);
  let scale = 1;
  if (longest < minEdge) scale = Math.min(3, minEdge / longest);
  else if (longest > maxEdge) scale = maxEdge / longest;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const straight = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .greyscale()
    .raw()
    .toBuffer();

  // The untouched grey levels of the page.
  const original = new Uint8ClampedArray(straight);

  // The same page with its lighting evened out and its tones stretched.
  let gray = stretchContrast(original);
  gray = correctIllumination(gray, width, height);
  gray = stretchContrast(gray, 0.01, 0.99);

  // The tilt is measured on a small copy, which is all the estimate needs.
  const searchWidth = 600;
  const searchHeight = Math.max(1, Math.round((height / width) * searchWidth));
  const small = await sharp(Buffer.from(gray), { raw: { width, height, channels: 1 } })
    .resize(searchWidth, searchHeight, { fit: "fill", kernel: "nearest" })
    .greyscale()
    .raw()
    .toBuffer();
  const smallGray = new Uint8ClampedArray(small);
  const smallBinary = sauvolaBinarize(
    smallGray,
    searchWidth,
    searchHeight,
    Math.max(8, Math.round(searchHeight / 30))
  );
  const skew = estimateSkew(smallBinary, searchWidth, searchHeight);

  // Straighten the page, then work on the straightened version.
  let work = gray;
  let plainWork = original;
  let workWidth = width;
  let workHeight = height;
  if (Math.abs(skew) >= 0.4) {
    // A positive tilt means the text descends to the right, so it has to be
    // turned back the other way.
    const rotated = await rotateGrey(gray, width, height, -skew);
    const rotatedPlain = await rotateGrey(original, width, height, -skew);
    work = rotated.data;
    plainWork = rotatedPlain.data;
    workWidth = rotated.info.width;
    workHeight = rotated.info.height;
  }

  work = medianFilter(work, workWidth, workHeight);

  // The hard rendering: local adaptive threshold, on a page whose lighting
  // has been evened out. This is the one that reads a photo of a poster.
  const binary = sauvolaBinarize(work, workWidth, workHeight);
  const binaryBuffer = await sharp(Buffer.from(binary), {
    raw: { width: workWidth, height: workHeight, channels: 1 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // The plain rendering: the same threshold, but on the untouched grey
  // levels. It keeps more detail on a page that is already evenly lit.
  const plainBinary = sauvolaBinarize(plainWork, workWidth, workHeight);
  const plainBuffer = await sharp(Buffer.from(plainBinary), {
    raw: { width: workWidth, height: workHeight, channels: 1 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // The soft rendering: grey levels, cleaned up and sharpened for the engine.
  const softBuffer = await sharp(Buffer.from(work), {
    raw: { width: workWidth, height: workHeight, channels: 1 },
  })
    .sharpen({ sigma: 1, m1: 0.6, m2: 2.2 })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    variants: [
      { name: "binarised", buffer: binaryBuffer },
      { name: "binarised-plain", buffer: plainBuffer },
      { name: "greyscale", buffer: softBuffer },
    ],
    stats: {
      width: workWidth,
      height: workHeight,
      skew: Math.round(skew * 10) / 10,
      sourceWidth,
      sourceHeight,
    },
  };
}

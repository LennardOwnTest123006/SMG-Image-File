import { fail, SmgErrorCode } from './errors.ts';

/** An 8-bit RGBA raster in row-major order (non-premultiplied alpha). */
export interface RgbaImage {
  width: number;
  height: number;
  /** width * height * 4 bytes, R,G,B,A order. */
  data: Uint8Array | Uint8ClampedArray;
}

export function assertImage(img: RgbaImage): void {
  if (!img || !Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1) {
    fail(SmgErrorCode.INVALID_ARGUMENT, 'image width/height must be positive integers');
  }
  if (!img.data || img.data.length !== img.width * img.height * 4) {
    fail(SmgErrorCode.INVALID_ARGUMENT, `image data must be width*height*4 = ${img.width * img.height * 4} bytes, got ${img.data?.length}`);
  }
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export interface ImageAnalysis {
  width: number;
  height: number;
  pixels: number;
  /** True if any pixel has alpha < 255. */
  hasAlpha: boolean;
  /** True if alpha only takes the values 0 and 255. */
  binaryAlpha: boolean;
  /** True if R == G == B everywhere. */
  grayscale: boolean;
  /** Number of distinct RGBA colours, or -1 if more than `maxColors`. */
  uniqueColors: number;
  /** Mean absolute horizontal+vertical luma gradient (0..255) — a smoothness measure. */
  meanGradient: number;
  /** Fraction of pixels whose luma equals its left neighbour's. */
  flatFraction: number;
  /** Heuristic content class. */
  kind: 'photo' | 'graphic' | 'screenshot' | 'flat';
}

/** Gather cheap statistics used by the encoder to choose a codec. */
export function analyzeImage(img: RgbaImage, maxColors = 256): ImageAnalysis {
  assertImage(img);
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  let hasAlpha = false;
  let binaryAlpha = true;
  let grayscale = true;
  const colors = new Map<number, number>();
  let tooMany = false;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
    if (a !== 255) {
      hasAlpha = true;
      if (a !== 0) binaryAlpha = false;
    }
    if (grayscale && (r !== g || g !== b)) grayscale = false;
    if (!tooMany) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!colors.has(key)) {
        colors.set(key, 1);
        if (colors.size > maxColors) tooMany = true;
      }
    }
  }
  // Gradient statistics on a subsample of rows for speed.
  const step = Math.max(1, Math.floor(h / 256));
  let gradSum = 0;
  let gradCount = 0;
  let flat = 0;
  for (let y = 1; y < h; y += step) {
    for (let x = 1; x < w; x++) {
      const p = (y * w + x) * 4;
      const l = (d[p] * 2 + d[p + 1] * 5 + d[p + 2]) >> 3;
      const lw = (d[p - 4] * 2 + d[p - 3] * 5 + d[p - 2]) >> 3;
      const pn = p - w * 4;
      const ln = (d[pn] * 2 + d[pn + 1] * 5 + d[pn + 2]) >> 3;
      gradSum += Math.abs(l - lw) + Math.abs(l - ln);
      if (l === lw) flat++;
      gradCount++;
    }
  }
  const meanGradient = gradCount ? gradSum / gradCount / 2 : 0;
  const flatFraction = gradCount ? flat / gradCount : 1;
  const uniqueColors = tooMany ? -1 : colors.size;
  let kind: ImageAnalysis['kind'];
  if (uniqueColors !== -1 && uniqueColors <= 16 && flatFraction > 0.6) kind = 'flat';
  else if (uniqueColors !== -1 || flatFraction > 0.55) kind = flatFraction > 0.7 ? 'screenshot' : 'graphic';
  else kind = 'photo';
  return {
    width: w,
    height: h,
    pixels: n,
    hasAlpha,
    binaryAlpha: hasAlpha && binaryAlpha,
    grayscale,
    uniqueColors,
    meanGradient,
    flatFraction,
    kind,
  };
}

/** True if both images have identical dimensions and RGBA bytes. */
export function pixelsEqual(a: RgbaImage, b: RgbaImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  const x = a.data, y = b.data;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Count pixels whose RGBA differ. */
export function countDifferentPixels(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
  let diff = 0;
  const x = a.data, y = b.data;
  for (let p = 0; p < x.length; p += 4) {
    if (x[p] !== y[p] || x[p + 1] !== y[p + 1] || x[p + 2] !== y[p + 2] || x[p + 3] !== y[p + 3]) diff++;
  }
  return diff;
}

/**
 * 64-bit (two 32-bit lanes) FNV-1a-style hash of the decoded pixels and
 * dimensions. Used for duplicate detection; not cryptographic.
 */
export function pixelHash(img: RgbaImage): string {
  let h1 = 0x811c9dc5 ^ img.width;
  let h2 = 0x01000193 ^ img.height;
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    h1 = Math.imul(h1 ^ d[i], 0x01000193);
    h2 = Math.imul(h2 ^ d[i] ^ (i & 0xff), 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

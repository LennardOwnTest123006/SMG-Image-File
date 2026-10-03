/** Geometric helpers on RGBA images (pure functions, return new images). */
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';

type Img = RgbaImage & { data: Uint8Array };

export function cropImage(img: RgbaImage, x: number, y: number, w: number, h: number): Img {
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(img.width - x, Math.floor(w));
  h = Math.min(img.height - y, Math.floor(h));
  if (w < 1 || h < 1) fail(SmgErrorCode.INVALID_ARGUMENT, 'crop rectangle is empty');
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data: out };
}

export function flipImage(img: RgbaImage, horizontal: boolean): Img {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = horizontal ? w - 1 - x : x;
      const sy = horizontal ? y : h - 1 - y;
      const s = (sy * w + sx) * 4, o = (y * w + x) * 4;
      out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = d[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Rotate clockwise by 90° × turns. */
export function rotateImage90(img: RgbaImage, turns: number): Img {
  const t = ((turns % 4) + 4) % 4;
  const { width: w, height: h, data: d } = img;
  if (t === 0) return { width: w, height: h, data: new Uint8Array(d) };
  const nw = t % 2 ? h : w, nh = t % 2 ? w : h;
  const out = new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (t === 1) { nx = h - 1 - y; ny = x; }
      else if (t === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const s = (y * w + x) * 4, o = (ny * nw + nx) * 4;
      out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = d[s + 3];
    }
  }
  return { width: nw, height: nh, data: out };
}

/** Apply an EXIF orientation (1..8) so pixels are in display orientation. */
export function applyOrientation(img: RgbaImage, orientation: number): Img {
  switch (orientation) {
    case 2: return flipImage(img, true);
    case 3: return rotateImage90(img, 2);
    case 4: return flipImage(img, false);
    case 5: return flipImage(rotateImage90(img, 1), true);
    case 6: return rotateImage90(img, 1);
    case 7: return flipImage(rotateImage90(img, 3), true);
    case 8: return rotateImage90(img, 3);
    default: return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  }
}

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Separable Lanczos-3 resampling in premultiplied-alpha space. */
export function resizeImage(img: RgbaImage, newW: number, newH: number): Img {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (newW * newH > 268_435_456) fail(SmgErrorCode.LIMIT_EXCEEDED, 'target size too large');
  const { width: w, height: h, data: d } = img;
  // premultiply into float
  const src = new Float32Array(w * h * 4);
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3] / 255;
    src[p] = d[p] * a; src[p + 1] = d[p + 1] * a; src[p + 2] = d[p + 2] * a; src[p + 3] = d[p + 3];
  }
  const pass = (inp: Float32Array, iw: number, ih: number, ow: number, horizontal: boolean): Float32Array => {
    const inLen = horizontal ? iw : ih;
    const outLen = ow;
    const other = horizontal ? ih : iw;
    const out = new Float32Array((horizontal ? ow * ih : iw * ow) * 4);
    const scale = inLen / outLen;
    const support = 3 * Math.max(1, scale);
    for (let o = 0; o < outLen; o++) {
      const center = (o + 0.5) * scale - 0.5;
      const start = Math.max(0, Math.floor(center - support));
      const end = Math.min(inLen - 1, Math.ceil(center + support));
      const weights: number[] = [];
      let sum = 0;
      for (let i = start; i <= end; i++) {
        const wt = lanczos((i - center) / Math.max(1, scale));
        weights.push(wt);
        sum += wt;
      }
      for (let k = 0; k < other; k++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let i = start; i <= end; i++) {
          const wt = weights[i - start] / sum;
          const s = (horizontal ? k * iw + i : i * iw + k) * 4;
          r += inp[s] * wt; g += inp[s + 1] * wt; b += inp[s + 2] * wt; a += inp[s + 3] * wt;
        }
        const t = (horizontal ? k * ow + o : o * iw + k) * 4;
        out[t] = r; out[t + 1] = g; out[t + 2] = b; out[t + 3] = a;
      }
    }
    return out;
  };
  const tmp = pass(src, w, h, newW, true);
  const fin = pass(tmp, newW, h, newH, false);
  const out = new Uint8Array(newW * newH * 4);
  for (let p = 0; p < out.length; p += 4) {
    const a = Math.min(255, Math.max(0, fin[p + 3]));
    const ia = a > 0 ? 255 / a : 0;
    const c = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
    out[p] = c(fin[p] * ia); out[p + 1] = c(fin[p + 1] * ia); out[p + 2] = c(fin[p + 2] * ia); out[p + 3] = c(a);
  }
  return { width: newW, height: newH, data: out };
}

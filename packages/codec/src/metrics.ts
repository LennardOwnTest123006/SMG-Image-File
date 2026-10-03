/**
 * Objective image-quality metrics used by the benchmark and the UI.
 *
 *  - PSNR over RGB. When either image has transparency, colours are compared
 *    premultiplied by alpha (what is actually visible) and alpha is included.
 *  - SSIM on luma (BT.601), Gaussian window σ = 1.5 (11 taps), standard
 *    constants K1 = 0.01, K2 = 0.03 (Wang et al., 2004).
 */
import type { RgbaImage } from './image.ts';
import { fail, SmgErrorCode } from './errors.ts';

function sameSize(a: RgbaImage, b: RgbaImage): void {
  if (a.width !== b.width || a.height !== b.height) fail(SmgErrorCode.INVALID_ARGUMENT, 'images must have the same dimensions');
}

function hasTransparency(img: RgbaImage): boolean {
  const d = img.data;
  for (let p = 3; p < d.length; p += 4) if (d[p] !== 255) return true;
  return false;
}

/**
 * Mean squared error over R, G, B — premultiplied by alpha, plus the alpha
 * channel itself, when either image is not fully opaque.
 */
export function mse(a: RgbaImage, b: RgbaImage): number {
  sameSize(a, b);
  const x = a.data, y = b.data;
  let s = 0;
  let n = 0;
  if (!hasTransparency(a) && !hasTransparency(b)) {
    for (let p = 0; p < x.length; p += 4) {
      const d0 = x[p] - y[p], d1 = x[p + 1] - y[p + 1], d2 = x[p + 2] - y[p + 2];
      s += d0 * d0 + d1 * d1 + d2 * d2;
    }
    n = (x.length / 4) * 3;
  } else {
    for (let p = 0; p < x.length; p += 4) {
      const ax = x[p + 3] / 255, ay = y[p + 3] / 255;
      const d0 = x[p] * ax - y[p] * ay, d1 = x[p + 1] * ax - y[p + 1] * ay, d2 = x[p + 2] * ax - y[p + 2] * ay;
      const d3 = x[p + 3] - y[p + 3];
      s += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
    }
    n = x.length;
  }
  return s / n;
}

/** PSNR in dB; Infinity for identical images. */
export function psnr(a: RgbaImage, b: RgbaImage): number {
  const m = mse(a, b);
  return m === 0 ? Infinity : 10 * Math.log10((255 * 255) / m);
}

/** Luma of the image composited over black (alpha-premultiplied). */
function luma(img: RgbaImage): Float32Array {
  const d = img.data;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = ((0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * d[p + 3]) / 255;
  return out;
}

const KERNEL = (() => {
  const k = new Float32Array(11);
  let s = 0;
  for (let i = 0; i < 11; i++) {
    const x = i - 5;
    k[i] = Math.exp(-(x * x) / (2 * 1.5 * 1.5));
    s += k[i];
  }
  for (let i = 0; i < 11; i++) k[i] /= s;
  return k;
})();

function blur(src: Float32Array, w: number, h: number, tmp: Float32Array, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -5; k <= 5; k++) {
        let xx = x + k;
        if (xx < 0) xx = -xx;
        else if (xx >= w) xx = 2 * w - 2 - xx;
        if (xx < 0 || xx >= w) xx = Math.min(w - 1, Math.max(0, xx));
        s += src[o + xx] * KERNEL[k + 5];
      }
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -5; k <= 5; k++) {
        let yy = y + k;
        if (yy < 0) yy = -yy;
        else if (yy >= h) yy = 2 * h - 2 - yy;
        if (yy < 0 || yy >= h) yy = Math.min(h - 1, Math.max(0, yy));
        s += tmp[yy * w + x] * KERNEL[k + 5];
      }
      out[y * w + x] = s;
    }
  }
}

/** Mean SSIM of the luma channel (0..1, 1 = identical). */
export function ssim(a: RgbaImage, b: RgbaImage): number {
  sameSize(a, b);
  const w = a.width, h = a.height;
  const x = luma(a), y = luma(b);
  const n = w * h;
  const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xx[i] = x[i] * x[i];
    yy[i] = y[i] * y[i];
    xy[i] = x[i] * y[i];
  }
  const tmp = new Float32Array(n);
  const mx = new Float32Array(n), my = new Float32Array(n), sxx = new Float32Array(n), syy = new Float32Array(n), sxy = new Float32Array(n);
  blur(x, w, h, tmp, mx);
  blur(y, w, h, tmp, my);
  blur(xx, w, h, tmp, sxx);
  blur(yy, w, h, tmp, syy);
  blur(xy, w, h, tmp, sxy);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const ux = mx[i], uy = my[i];
    const vx = sxx[i] - ux * ux, vy = syy[i] - uy * uy, cxy = sxy[i] - ux * uy;
    s += ((2 * ux * uy + C1) * (2 * cxy + C2)) / ((ux * ux + uy * uy + C1) * (vx + vy + C2));
  }
  return s / n;
}

/** Bits per pixel for a given byte size. */
export function bitsPerPixel(bytes: number, width: number, height: number): number {
  return (bytes * 8) / (width * height);
}

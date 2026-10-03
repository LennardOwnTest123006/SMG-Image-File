/**
 * Colour quantisation for the lossy palette mode: weighted median-cut on a
 * 5-bit-per-channel RGBA histogram, refined with a few k-means iterations,
 * followed by nearest-colour mapping with optional Floyd–Steinberg dithering.
 */
import type { RgbaImage } from './image.ts';

const WR = 3, WG = 4, WB = 2, WA = 4;

interface Bucket {
  r: number; g: number; b: number; a: number; // weighted sums
  n: number;
}

function dist(r: number, g: number, b: number, a: number, p: Float64Array, i: number): number {
  const dr = r - p[i], dg = g - p[i + 1], db = b - p[i + 2], da = a - p[i + 3];
  return WR * dr * dr + WG * dg * dg + WB * db * db + WA * da * da;
}

export interface QuantizeOptions {
  maxColors: number;
  dither?: boolean;
  /** k-means refinement iterations (default 4). */
  iterations?: number;
}

/** Returns a new image using at most `maxColors` distinct RGBA colours. */
export function quantizeImage(img: RgbaImage, opts: QuantizeOptions): RgbaImage {
  const maxColors = Math.max(2, Math.min(256, Math.floor(opts.maxColors)));
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  // --- histogram ---
  const map = new Map<number, number>();
  const buckets: Bucket[] = [];
  for (let p = 0; p < n * 4; p += 4) {
    const a = d[p + 3];
    const r = a === 0 ? 0 : d[p], g = a === 0 ? 0 : d[p + 1], b = a === 0 ? 0 : d[p + 2];
    const key = ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
    let bi = map.get(key);
    if (bi === undefined) {
      bi = buckets.length;
      map.set(key, bi);
      buckets.push({ r: 0, g: 0, b: 0, a: 0, n: 0 });
    }
    const bk = buckets[bi];
    bk.r += r; bk.g += g; bk.b += b; bk.a += a; bk.n++;
  }
  const B = buckets.length;
  const br = new Float64Array(B), bg = new Float64Array(B), bb = new Float64Array(B), ba = new Float64Array(B), bn = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    const k = buckets[i];
    br[i] = k.r / k.n; bg[i] = k.g / k.n; bb[i] = k.b / k.n; ba[i] = k.a / k.n; bn[i] = k.n;
  }
  // --- median cut ---
  type Box = { idx: number[]; score: number; axis: number };
  const chans = [br, bg, bb, ba];
  const wts = [WR, WG, WB, WA];
  const makeBox = (idx: number[]): Box => {
    let best = 0, axis = 0;
    for (let c = 0; c < 4; c++) {
      let s = 0, s2 = 0, cnt = 0;
      for (const i of idx) { const v = chans[c][i]; s += v * bn[i]; s2 += v * v * bn[i]; cnt += bn[i]; }
      const variance = (s2 / cnt - (s / cnt) ** 2) * wts[c] * cnt;
      if (variance > best) { best = variance; axis = c; }
    }
    return { idx, score: idx.length > 1 ? best : -1, axis };
  };
  const boxes: Box[] = [makeBox([...Array(B).keys()])];
  while (boxes.length < maxColors) {
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > 0 && (bi < 0 || boxes[i].score > boxes[bi].score)) bi = i;
    if (bi < 0) break;
    const box = boxes[bi];
    const ch = chans[box.axis];
    box.idx.sort((x, y) => ch[x] - ch[y]);
    let total = 0;
    for (const i of box.idx) total += bn[i];
    let acc = 0, cut = 1;
    for (let k = 0; k < box.idx.length - 1; k++) {
      acc += bn[box.idx[k]];
      if (acc >= total / 2) { cut = k + 1; break; }
      cut = k + 1;
    }
    const left = box.idx.slice(0, cut), right = box.idx.slice(cut);
    boxes.splice(bi, 1, makeBox(left), makeBox(right));
  }
  let K = boxes.length;
  let pal = new Float64Array(K * 4);
  boxes.forEach((box, j) => {
    let r = 0, g = 0, b = 0, a = 0, c = 0;
    for (const i of box.idx) { r += br[i] * bn[i]; g += bg[i] * bn[i]; b += bb[i] * bn[i]; a += ba[i] * bn[i]; c += bn[i]; }
    pal[j * 4] = r / c; pal[j * 4 + 1] = g / c; pal[j * 4 + 2] = b / c; pal[j * 4 + 3] = a / c;
  });
  // --- k-means refinement on buckets ---
  const iters = opts.iterations ?? 4;
  const assign = new Int32Array(B);
  for (let it = 0; it < iters; it++) {
    const acc = new Float64Array(K * 5);
    for (let i = 0; i < B; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < K; j++) {
        const dd = dist(br[i], bg[i], bb[i], ba[i], pal, j * 4);
        if (dd < bd) { bd = dd; best = j; }
      }
      assign[i] = best;
      const o = best * 5;
      acc[o] += br[i] * bn[i]; acc[o + 1] += bg[i] * bn[i]; acc[o + 2] += bb[i] * bn[i]; acc[o + 3] += ba[i] * bn[i]; acc[o + 4] += bn[i];
    }
    for (let j = 0; j < K; j++) {
      const o = j * 5;
      if (acc[o + 4] > 0) for (let c = 0; c < 4; c++) pal[j * 4 + c] = acc[o + c] / acc[o + 4];
    }
  }
  // Snap entries to integers; force exact opaque/transparent alpha where close.
  const ip = new Uint8Array(K * 4);
  for (let j = 0; j < K * 4; j++) {
    let v = Math.round(pal[j]);
    if ((j & 3) === 3) { if (v >= 250) v = 255; else if (v <= 4) v = 0; }
    ip[j] = Math.max(0, Math.min(255, v));
    pal[j] = ip[j];
  }
  // Transparent entries carry no colour.
  for (let j = 0; j < K; j++) if (ip[j * 4 + 3] === 0) { ip[j * 4] = ip[j * 4 + 1] = ip[j * 4 + 2] = 0; pal[j * 4] = pal[j * 4 + 1] = pal[j * 4 + 2] = 0; }
  // Deduplicate entries.
  const seen = new Map<number, number>();
  const uniq: number[] = [];
  for (let j = 0; j < K; j++) {
    const key = (ip[j * 4] << 24) | (ip[j * 4 + 1] << 16) | (ip[j * 4 + 2] << 8) | ip[j * 4 + 3];
    if (!seen.has(key)) { seen.set(key, uniq.length); uniq.push(j); }
  }
  if (uniq.length !== K) {
    const np = new Float64Array(uniq.length * 4);
    uniq.forEach((j, k) => { for (let c = 0; c < 4; c++) np[k * 4 + c] = pal[j * 4 + c]; });
    pal = np;
    K = uniq.length;
  }
  // --- mapping ---
  const out = new Uint8Array(n * 4);
  const nearest = (r: number, g: number, b: number, a: number): number => {
    let best = 0, bd = Infinity;
    for (let j = 0; j < K; j++) {
      const dd = dist(r, g, b, a, pal, j * 4);
      if (dd < bd) { bd = dd; best = j; }
    }
    return best;
  };
  if (!opts.dither) {
    const cache = new Map<number, number>();
    for (let p = 0; p < n * 4; p += 4) {
      const a = d[p + 3];
      const r = a === 0 ? 0 : d[p], g = a === 0 ? 0 : d[p + 1], b = a === 0 ? 0 : d[p + 2];
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      let j = cache.get(key);
      if (j === undefined) { j = nearest(r, g, b, a); cache.set(key, j); }
      out[p] = pal[j * 4]; out[p + 1] = pal[j * 4 + 1]; out[p + 2] = pal[j * 4 + 2]; out[p + 3] = pal[j * 4 + 3];
    }
  } else {
    // Floyd–Steinberg with serpentine scanning; error buffers for current/next row.
    let cur = new Float32Array((w + 2) * 4);
    let nxt = new Float32Array((w + 2) * 4);
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const p = (y * w + x) * 4;
        const e = (x + 1) * 4;
        const a0 = d[p + 3];
        const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
        const r = clamp((a0 === 0 ? 0 : d[p]) + cur[e]);
        const g = clamp((a0 === 0 ? 0 : d[p + 1]) + cur[e + 1]);
        const b = clamp((a0 === 0 ? 0 : d[p + 2]) + cur[e + 2]);
        const a = clamp(a0 + cur[e + 3]);
        const j = nearest(r, g, b, a);
        const q = [pal[j * 4], pal[j * 4 + 1], pal[j * 4 + 2], pal[j * 4 + 3]];
        out[p] = q[0]; out[p + 1] = q[1]; out[p + 2] = q[2]; out[p + 3] = q[3];
        const err = [r - q[0], g - q[1], b - q[2], a - q[3]];
        const fw = ltr ? 4 : -4;
        for (let c = 0; c < 4; c++) {
          const ev = err[c] * 0.85; // slightly damped to limit noise
          cur[e + fw + c] += (ev * 7) / 16;
          nxt[e - fw + c] += (ev * 3) / 16;
          nxt[e + c] += (ev * 5) / 16;
          nxt[e + fw + c] += ev / 16;
        }
      }
      const t = cur; cur = nxt; nxt = t; nxt.fill(0);
    }
  }
  return { width: w, height: h, data: out };
}

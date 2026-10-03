/**
 * SMG-W — lossy wavelet codec.
 *
 * Pipeline: (optional transparent-pixel fill) → YCbCr (optionally 2×2
 * chroma subsampling) → 9/7 DWT → dead-zone scalar quantisation with
 * per-sub-band perceptual weights → context-modelled coefficient coding.
 * Alpha is coded losslessly with the SMG-L plane engine.
 *
 * Payload layout (DATA chunk, codec id 3):
 *   u8   flags        bit0 colour (3 channels) else gray, bit1 chroma 2×2 subsampled, bit2 alpha present
 *   f32  baseStep     luma quantiser step
 *   f32  chromaScale  multiplier applied to chroma steps
 *   u8   recon        reconstruction offset δ = recon / 256 (dequantise to (|q| + δ) · step)
 *   u8   levelsY      decomposition levels of the luma / gray plane
 *   u8   levelsC      decomposition levels of the chroma planes (0 if gray)
 *   [alpha]  varint length + SMG-L single-plane stream
 *   ...  range-coded coefficients
 */
import { ByteReader, ByteWriter } from '../bytes.ts';
import { IntContexts } from '../entropy/intcoder.ts';
import { Models, RangeDecoder, RangeEncoder } from '../entropy/rangecoder.ts';
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';
import { forward2d, inverse2d, levelsFor, subbands, type Subband } from './dwt.ts';
import { decodePlanes, encodePlanes } from './planes.ts';

const FLAG_COLOR = 1;
const FLAG_SUBSAMPLED = 2;
const FLAG_ALPHA = 4;

const EMAX = 20;
const NBK = 14;
const BLOCK = 8;
const MAX_Q = 2 ** EMAX - 1;

/** Perceptual step multipliers indexed by [level-1][orientation class 0=HL/LH,1=HH]. */
const WEIGHTS: number[][] = [
  [1.3, 1.8],
  [1.12, 1.35],
  [1.03, 1.15],
  [1.0, 1.05],
  [1.0, 1.0],
  [1.0, 1.0],
];

/** Default multiplier of chroma quantiser steps relative to luma. */
export const DEFAULT_CHROMA_SCALE = 1.2;

/**
 * Map quality 1..100 to the luma quantiser step (piecewise log-linear):
 * q 100 → 0.5 (near-lossless), q 80 → ≈6, q 50 → ≈20, q 1 → ≈150.
 */
export function stepForQuality(quality: number): number {
  const q = Math.min(100, Math.max(1, quality));
  const l = q >= 80 ? -1 + (100 - q) * 0.18 : 2.6 + (80 - q) * 0.0587;
  return 2 ** l;
}

/** Inverse of stepForQuality (for reporting the effective quality of a step). */
export function qualityForStep(step: number): number {
  const l = Math.log2(step);
  const q = l <= 2.6 ? 100 - (l + 1) / 0.18 : 80 - (l - 2.6) / 0.0587;
  return Math.max(1, Math.min(100, Math.round(q)));
}

/** Chroma is subsampled 2×2 below this quality. */
export const SUBSAMPLE_BELOW_QUALITY = 90;

const MAG_Q = (() => {
  const t = new Uint8Array(1024);
  const th = [0, 1, 2, 3, 4, 6, 8, 11, 15, 21, 30, 44, 66];
  for (let v = 0; v < 1024; v++) {
    let b = 0;
    while (b < th.length && v > th[b]) b++;
    t[v] = Math.min(NBK - 1, b);
  }
  return t;
})();
function qmag(v: number): number {
  return v < 1024 ? MAG_Q[v] : NBK - 1;
}

interface PlaneInfo {
  w: number;
  h: number;
  levels: number;
  bands: Subband[];
  chroma: boolean;
}

function bandStep(base: number, chromaScale: number, plane: PlaneInfo, sb: Subband): number {
  let s = base * (plane.chroma ? chromaScale : 1);
  if (sb.orient !== 0) s *= WEIGHTS[Math.min(5, sb.level - 1)][sb.orient === 3 ? 1 : 0];
  return s;
}

type Coder = { enc: RangeEncoder; dec?: undefined } | { dec: RangeDecoder; enc?: undefined };

/**
 * Shared encode/decode for one plane's quantised coefficients. `qOut` must be
 * zero-initialised; contexts are computed only from `qOut`, which the encoder
 * fills in coding order, so both sides see identical state.
 */
function runPlane(coder: Coder, qIn: Int32Array | null, qOut: Int32Array, pl: PlaneInfo, ctx: CoefContexts): void {
  const W = pl.w;
  const chanClass = pl.chroma ? 1 : 0;
  const encoding = coder.enc !== undefined;
  const bandByKey = new Map<string, Subband>();
  for (const sb of pl.bands) bandByKey.set(`${sb.orient}:${sb.level}`, sb);

  for (const sb of pl.bands) {
    if (sb.w === 0 || sb.h === 0) continue;
    if (sb.orient === 0) {
      // LL band: DPCM with median predictor.
      for (let y = 0; y < sb.h; y++) {
        for (let x = 0; x < sb.w; x++) {
          const i = (sb.y0 + y) * W + sb.x0 + x;
          const N = y > 0 ? qOut[i - W] : x > 0 ? qOut[i - 1] : 0;
          const Wv = x > 0 ? qOut[i - 1] : N;
          const NW = x > 0 && y > 0 ? qOut[i - W - 1] : N;
          const mx = Wv > N ? Wv : N, mn = Wv > N ? N : Wv;
          const pred = NW >= mx ? mn : NW <= mn ? mx : Wv + N - NW;
          const act = Math.abs(Wv - NW) + Math.abs(N - NW);
          const set = chanClass * NBK + qmag(act);
          if (encoding) {
            const v = qIn![i];
            ctx.ll.encode(coder.enc, set, v - pred);
            qOut[i] = v;
          } else {
            const v = pred + ctx.ll.decode(coder.dec!, set);
            if (v > MAX_Q || v < -MAX_Q) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'LL coefficient out of range');
            qOut[i] = v;
          }
        }
      }
      continue;
    }
    const levelClass = sb.level === 1 ? 0 : sb.level === 2 ? 1 : 2;
    const orientClass = sb.orient === 3 ? 1 : 0;
    const cls = (chanClass * 3 + levelClass) * 2 + orientClass;
    const parent = bandByKey.get(`${sb.orient}:${sb.level + 1}`);
    const sib1 = sb.orient === 2 ? bandByKey.get(`1:${sb.level}`) : sb.orient === 3 ? bandByKey.get(`1:${sb.level}`) : undefined;
    const sib2 = sb.orient === 3 ? bandByKey.get(`2:${sb.level}`) : undefined;
    const bw = Math.ceil(sb.w / BLOCK);
    const bh = Math.ceil(sb.h / BLOCK);
    const flags = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const xs = bx * BLOCK, ys = by * BLOCK;
        const xe = Math.min(sb.w, xs + BLOCK), ye = Math.min(sb.h, ys + BLOCK);
        // Parent activity over the co-located parent area.
        let pnz = 0;
        if (parent) {
          const pxs = xs >> 1, pys = ys >> 1;
          const pxe = Math.min(parent.w, (xe + 1) >> 1), pye = Math.min(parent.h, (ye + 1) >> 1);
          for (let py = pys; py < pye && !pnz; py++) {
            const o = (parent.y0 + py) * W + parent.x0;
            for (let px = pxs; px < pxe; px++) if (qOut[o + px] !== 0) { pnz = 1; break; }
          }
        }
        let snz = 0;
        if (sib1) snz = blockAny(qOut, W, sib1, xs, ys, xe, ye) ? 1 : 0;
        const left = bx > 0 ? flags[by * bw + bx - 1] : 0;
        const up = by > 0 ? flags[(by - 1) * bw + bx] : 0;
        const fctx = (cls * 16) + left + up * 2 + pnz * 4 + snz * 8;
        let any: number;
        if (encoding) {
          any = 0;
          for (let y = ys; y < ye && !any; y++) {
            const o = (sb.y0 + y) * W + sb.x0;
            for (let x = xs; x < xe; x++) if (qIn![o + x] !== 0) { any = 1; break; }
          }
          coder.enc.encode(ctx.block, fctx, any);
        } else {
          any = coder.dec!.decode(ctx.block, fctx);
        }
        flags[by * bw + bx] = any;
        if (!any) continue;
        for (let y = ys; y < ye; y++) {
          const row = (sb.y0 + y) * W + sb.x0;
          for (let x = xs; x < xe; x++) {
            const i = row + x;
            const vW = x > 0 ? qOut[i - 1] : 0;
            const vN = y > 0 ? qOut[i - W] : 0;
            const aW = vW < 0 ? -vW : vW;
            const aN = vN < 0 ? -vN : vN;
            let aNW = 0, aNE = 0;
            if (y > 0) {
              if (x > 0) { const t = qOut[i - W - 1]; aNW = t < 0 ? -t : t; }
              if (x < sb.w - 1) { const t = qOut[i - W + 1]; aNE = t < 0 ? -t : t; }
            }
            let aP = 0;
            if (parent) {
              const px = Math.min(x >> 1, parent.w - 1), py = Math.min(y >> 1, parent.h - 1);
              const t = qOut[(parent.y0 + py) * W + parent.x0 + px];
              aP = t < 0 ? -t : t;
            }
            let aS = 0;
            if (sib1 && x < sib1.w && y < sib1.h) { const t = qOut[(sib1.y0 + y) * W + sib1.x0 + x]; aS += t < 0 ? -t : t; }
            if (sib2 && x < sib2.w && y < sib2.h) { const t = qOut[(sib2.y0 + y) * W + sib2.x0 + x]; aS += t < 0 ? -t : t; }
            const m = 2 * (aW + aN) + aNW + aNE + 2 * aP + aS;
            const set = cls * NBK + qmag(m);
            const sctx = (vW > 0 ? 2 : vW < 0 ? 0 : 1) * 3 + (vN > 0 ? 2 : vN < 0 ? 0 : 1);
            if (encoding) {
              const v = qIn![i];
              ctx.coef.encode(coder.enc, set, v, sctx);
              qOut[i] = v;
            } else {
              qOut[i] = ctx.coef.decode(coder.dec!, set, sctx);
            }
          }
        }
      }
    }
  }
}

function blockAny(q: Int32Array, W: number, sb: Subband, xs: number, ys: number, xe: number, ye: number): boolean {
  const x1 = Math.min(xe, sb.w), y1 = Math.min(ye, sb.h);
  for (let y = ys; y < y1; y++) {
    const o = (sb.y0 + y) * W + sb.x0;
    for (let x = xs; x < x1; x++) if (q[o + x] !== 0) return true;
  }
  return false;
}

class CoefContexts {
  readonly ll = new IntContexts(2 * NBK, EMAX, 1);
  readonly coef = new IntContexts(2 * 3 * 2 * NBK, EMAX, 9);
  readonly block = new Models(2 * 3 * 2 * 16);
}

/** Fill colour of fully transparent pixels from nearby opaque ones (reduces edge cost). */
function fillTransparent(img: RgbaImage): Uint8Array {
  const { width: w, height: h } = img;
  const d = new Uint8Array(img.data);
  let prevRowHasOpaque = false;
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (d[o + x * 4 + 3] !== 0) {
        // fill the gap (last, x) by linear interpolation
        const gs = last + 1;
        if (x - gs > 0) {
          for (let g = gs; g < x; g++) {
            const t = last < 0 ? 1 : (g - last) / (x - last);
            for (let c = 0; c < 3; c++) {
              const a = last < 0 ? d[o + x * 4 + c] : d[o + last * 4 + c];
              d[o + g * 4 + c] = Math.round(a + (d[o + x * 4 + c] - a) * t);
            }
          }
        }
        last = x;
      }
    }
    if (last >= 0) {
      for (let g = last + 1; g < w; g++) for (let c = 0; c < 3; c++) d[o + g * 4 + c] = d[o + last * 4 + c];
      prevRowHasOpaque = true;
    } else if (prevRowHasOpaque) {
      d.copyWithin(o, o - w * 4, o);
      for (let x = 0; x < w; x++) d[o + x * 4 + 3] = 0;
    }
  }
  // Propagate upwards into leading fully transparent rows.
  let firstOpaqueRow = -1;
  for (let y = 0; y < h && firstOpaqueRow < 0; y++) {
    for (let x = 0; x < w; x++) if (img.data[(y * w + x) * 4 + 3] !== 0) { firstOpaqueRow = y; break; }
  }
  for (let y = firstOpaqueRow - 1; y >= 0; y--) {
    const o = y * w * 4;
    d.copyWithin(o, o + w * 4, o + 2 * w * 4);
    for (let x = 0; x < w; x++) d[o + x * 4 + 3] = 0;
  }
  return d;
}

export interface WaveletPrepared {
  w: number;
  h: number;
  color: boolean;
  subsampled: boolean;
  planes: Float32Array[];
  infos: PlaneInfo[];
  alphaStream: Uint8Array | null;
}

export interface WaveletOptions {
  /** Downsample chroma 2×2 (default: true when quality < 90). */
  subsample: boolean;
  /** Encode as single gray channel. */
  gray: boolean;
  /** Code alpha losslessly. */
  alpha: boolean;
}

export function prepareWavelet(img: RgbaImage, opts: WaveletOptions): WaveletPrepared {
  const { width: w, height: h } = img;
  const src = opts.alpha ? fillTransparent(img) : img.data;
  const n = w * h;
  const planes: Float32Array[] = [];
  const infos: PlaneInfo[] = [];
  const Y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    Y[i] = opts.gray ? src[p] - 128 : 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2] - 128;
  }
  planes.push(Y);
  infos.push({ w, h, levels: levelsFor(w, h), bands: [], chroma: false });
  if (!opts.gray) {
    const cw = opts.subsample ? Math.ceil(w / 2) : w;
    const ch = opts.subsample ? Math.ceil(h / 2) : h;
    const Cb = new Float32Array(cw * ch);
    const Cr = new Float32Array(cw * ch);
    if (opts.subsample) {
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          let sb = 0, sr = 0, cnt = 0;
          for (let dy = 0; dy < 2; dy++) {
            const yy = y * 2 + dy;
            if (yy >= h) continue;
            for (let dx = 0; dx < 2; dx++) {
              const xx = x * 2 + dx;
              if (xx >= w) continue;
              const p = (yy * w + xx) * 4;
              const r = src[p], g = src[p + 1], b = src[p + 2];
              sb += -0.168736 * r - 0.331264 * g + 0.5 * b;
              sr += 0.5 * r - 0.418688 * g - 0.081312 * b;
              cnt++;
            }
          }
          Cb[y * cw + x] = sb / cnt;
          Cr[y * cw + x] = sr / cnt;
        }
      }
    } else {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = src[p], g = src[p + 1], b = src[p + 2];
        Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
    }
    const lc = levelsFor(cw, ch);
    planes.push(Cb, Cr);
    infos.push({ w: cw, h: ch, levels: lc, bands: [], chroma: true }, { w: cw, h: ch, levels: lc, bands: [], chroma: true });
  }
  for (let k = 0; k < planes.length; k++) {
    const pi = infos[k];
    pi.bands = subbands(pi.w, pi.h, pi.levels);
    forward2d(planes[k], pi.w, pi.h, pi.levels);
  }
  let alphaStream: Uint8Array | null = null;
  if (opts.alpha) {
    const enc = new RangeEncoder(Math.max(256, n >> 4));
    const d = img.data;
    encodePlanes(enc, [{ min: 0, max: 255, ref: -1 }], w, h, (y, buf, off) => {
      const A = buf[0];
      const p = y * w * 4 + 3;
      for (let x = 0; x < w; x++) A[off + x] = d[p + x * 4];
    });
    alphaStream = enc.finish();
  }
  return { w, h, color: !opts.gray, subsampled: !opts.gray && opts.subsample, planes, infos, alphaStream };
}

/** Rounding offset used by the dead-zone quantiser (|q| = floor(|c|/step + ROUND)). */
const ROUND = 0.38;
/** Reconstruction offset written to the stream (δ = RECON/256). */
const RECON = 20;

export function codeWavelet(prep: WaveletPrepared, baseStep: number, chromaScale: number): Uint8Array {
  const head = new ByteWriter(64);
  const flags = (prep.color ? FLAG_COLOR : 0) | (prep.subsampled ? FLAG_SUBSAMPLED : 0) | (prep.alphaStream ? FLAG_ALPHA : 0);
  head.u8(flags).f32(baseStep).f32(chromaScale).u8(RECON).u8(prep.infos[0].levels).u8(prep.color ? prep.infos[1].levels : 0);
  // Round-trip the floats through f32 so encoder and decoder use identical steps.
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, baseStep, true);
  const base32 = dv.getFloat32(0, true);
  dv.setFloat32(0, chromaScale, true);
  const chroma32 = dv.getFloat32(0, true);
  if (prep.alphaStream) head.block(prep.alphaStream);
  const total = prep.planes.reduce((s, p) => s + p.length, 0);
  const enc = new RangeEncoder(Math.max(1024, total >> 3));
  const ctx = new CoefContexts();
  for (let k = 0; k < prep.planes.length; k++) {
    const pl = prep.infos[k];
    const src = prep.planes[k];
    const q = new Int32Array(src.length);
    for (const sb of pl.bands) {
      const step = bandStep(base32, chroma32, pl, sb);
      const inv = 1 / step;
      for (let y = 0; y < sb.h; y++) {
        const o = (sb.y0 + y) * pl.w + sb.x0;
        for (let x = 0; x < sb.w; x++) {
          const c = src[o + x];
          let v: number;
          if (sb.orient === 0) v = Math.round(c * inv);
          else {
            const a = Math.floor((c < 0 ? -c : c) * inv + ROUND);
            v = c < 0 ? -a : a;
          }
          if (v > MAX_Q) v = MAX_Q;
          else if (v < -MAX_Q) v = -MAX_Q;
          q[o + x] = v;
        }
      }
    }
    runPlane({ enc }, q, new Int32Array(src.length), pl, ctx);
  }
  const body = enc.finish();
  const h = head.finish();
  const out = new Uint8Array(h.length + body.length);
  out.set(h);
  out.set(body, h.length);
  return out;
}

export function decodeWavelet(payload: Uint8Array, w: number, h: number, hasAlpha: boolean, gray: boolean): Uint8Array {
  const r = new ByteReader(payload, 0, payload.length, 'wavelet payload');
  const flags = r.u8();
  const base = r.f32();
  const chromaScale = r.f32();
  const recon = r.u8() / 256;
  const levelsY = r.u8();
  const levelsC = r.u8();
  const color = (flags & FLAG_COLOR) !== 0;
  const subsampled = (flags & FLAG_SUBSAMPLED) !== 0;
  const alpha = (flags & FLAG_ALPHA) !== 0;
  if (flags & ~7) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'unknown wavelet flags');
  if (color === gray) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'wavelet channel layout does not match colour model');
  if (alpha !== hasAlpha) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'wavelet alpha flag does not match colour model');
  if (!(base > 0 && base < 1e6) || !(chromaScale > 0 && chromaScale < 1e3)) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid quantiser step');
  if (levelsY > 16 || levelsC > 16) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid level count');
  const out = new Uint8Array(w * h * 4);
  if (alpha) {
    const a = r.block();
    const dec = new RangeDecoder(a);
    decodePlanes(dec, [{ min: 0, max: 255, ref: -1 }], w, h, (y, buf, off) => {
      const A = buf[0];
      const p = y * w * 4 + 3;
      for (let x = 0; x < w; x++) out[p + x * 4] = A[off + x];
    });
  } else {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
  const infos: PlaneInfo[] = [{ w, h, levels: levelsY, bands: subbands(w, h, levelsY), chroma: false }];
  if (color) {
    const cw = subsampled ? Math.ceil(w / 2) : w;
    const ch = subsampled ? Math.ceil(h / 2) : h;
    const cb = subbands(cw, ch, levelsC);
    infos.push({ w: cw, h: ch, levels: levelsC, bands: cb, chroma: true }, { w: cw, h: ch, levels: levelsC, bands: cb, chroma: true });
  }
  for (const pi of infos) {
    let dw = pi.w, dh = pi.h;
    for (let l = 0; l < pi.levels; l++) {
      if (dw < 1 || dh < 1) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'too many decomposition levels');
      dw = Math.ceil(dw / 2);
      dh = Math.ceil(dh / 2);
    }
  }
  const dec = new RangeDecoder(payload, r.pos);
  const ctx = new CoefContexts();
  const planes: Float32Array[] = [];
  for (const pl of infos) {
    const q = new Int32Array(pl.w * pl.h);
    runPlane({ dec }, null, q, pl, ctx);
    const p = new Float32Array(pl.w * pl.h);
    for (const sb of pl.bands) {
      const step = bandStep(base, chromaScale, pl, sb);
      for (let y = 0; y < sb.h; y++) {
        const o = (sb.y0 + y) * pl.w + sb.x0;
        for (let x = 0; x < sb.w; x++) {
          const v = q[o + x];
          if (v === 0) continue;
          if (sb.orient === 0) p[o + x] = v * step;
          else p[o + x] = v > 0 ? (v + recon) * step : (v - recon) * step;
        }
      }
    }
    inverse2d(p, pl.w, pl.h, pl.levels);
    planes.push(p);
  }
  const Y = planes[0];
  if (!color) {
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const v = Math.round(Y[i] + 128);
      const c = v < 0 ? 0 : v > 255 ? 255 : v;
      out[p] = out[p + 1] = out[p + 2] = c;
    }
    return out;
  }
  const Cb = planes[1], Cr = planes[2];
  const cw = infos[1].w, ch = infos[1].h;
  for (let y = 0; y < h; y++) {
    // Bilinear chroma upsampling with centred sample positions.
    let y0 = 0, y1 = 0, fy = 0;
    if (subsampled) {
      const sy = (y + 0.5) / 2 - 0.5;
      y0 = Math.floor(sy);
      fy = sy - y0;
      y1 = Math.min(ch - 1, y0 + 1);
      if (y0 < 0) y0 = 0;
    }
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let cb: number, cr: number;
      if (subsampled) {
        const sx = (x + 0.5) / 2 - 0.5;
        let x0 = Math.floor(sx);
        const fx = sx - x0;
        const x1 = Math.min(cw - 1, x0 + 1);
        if (x0 < 0) x0 = 0;
        const a = y0 * cw, b = y1 * cw;
        cb = (Cb[a + x0] * (1 - fx) + Cb[a + x1] * fx) * (1 - fy) + (Cb[b + x0] * (1 - fx) + Cb[b + x1] * fx) * fy;
        cr = (Cr[a + x0] * (1 - fx) + Cr[a + x1] * fx) * (1 - fy) + (Cr[b + x0] * (1 - fx) + Cr[b + x1] * fx) * fy;
      } else {
        cb = Cb[i];
        cr = Cr[i];
      }
      const yy = Y[i] + 128;
      const R = Math.round(yy + 1.402 * cr);
      const G = Math.round(yy - 0.344136 * cb - 0.714136 * cr);
      const B = Math.round(yy + 1.772 * cb);
      const p = i * 4;
      out[p] = R < 0 ? 0 : R > 255 ? 255 : R;
      out[p + 1] = G < 0 ? 0 : G > 255 ? 255 : G;
      out[p + 2] = B < 0 ? 0 : B > 255 ? 255 : B;
    }
  }
  return out;
}

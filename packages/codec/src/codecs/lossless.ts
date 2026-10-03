/**
 * SMG-L — lossless predictive codec for 8-bit Gray/GrayAlpha/RGB/RGBA images.
 *
 * Payload layout (DATA chunk, codec id 1):
 *   u8   transform   0 = none (R,G,B), 1 = YCoCg-R, 2 = subtract-green (G, R-G, B-G)
 *   u8   flags       bit0 = LZ (pixel-run copies enabled); other bits reserved (0)
 *   ...  range-coded plane data (see planes.ts)
 */
import { RangeDecoder, RangeEncoder } from '../entropy/rangecoder.ts';
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';
import { ColorModel, modelHasAlpha, modelIsGray } from '../types.ts';
import { decodePlanes, encodePlanes, type PlaneSpec } from './planes.ts';

export const Transform = { NONE: 0, YCOCG: 1, SUBGREEN: 2 } as const;
export type Transform = (typeof Transform)[keyof typeof Transform];

function planeSpecs(model: number, transform: number): PlaneSpec[] {
  const specs: PlaneSpec[] = [];
  if (modelHasAlpha(model)) specs.push({ min: 0, max: 255, ref: -1 });
  const first = specs.length;
  if (modelIsGray(model)) {
    specs.push({ min: 0, max: 255, ref: -1 });
  } else if (transform === Transform.NONE) {
    specs.push({ min: 0, max: 255, ref: -1 }, { min: 0, max: 255, ref: first }, { min: 0, max: 255, ref: first });
  } else {
    specs.push({ min: 0, max: 255, ref: -1 }, { min: -255, max: 255, ref: first }, { min: -255, max: 255, ref: first });
  }
  return specs;
}

/** Forward colour transform of one pixel into plane rows. */
function makeFill(img: RgbaImage, model: number, transform: number) {
  const d = img.data;
  const w = img.width;
  const alpha = modelHasAlpha(model);
  const gray = modelIsGray(model);
  return (y: number, buf: Int16Array[], off: number) => {
    let k0 = 0;
    let p = y * w * 4;
    if (alpha) {
      const A = buf[0];
      for (let x = 0; x < w; x++) A[off + x] = d[p + x * 4 + 3];
      k0 = 1;
    }
    if (gray) {
      const G = buf[k0];
      for (let x = 0; x < w; x++, p += 4) G[off + x] = d[p];
      return;
    }
    const P0 = buf[k0], P1 = buf[k0 + 1], P2 = buf[k0 + 2];
    for (let x = 0; x < w; x++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      if (transform === Transform.YCOCG) {
        const co = r - b;
        const t = b + (co >> 1);
        const cg = g - t;
        P0[off + x] = t + (cg >> 1);
        P1[off + x] = co;
        P2[off + x] = cg;
      } else if (transform === Transform.SUBGREEN) {
        P0[off + x] = g;
        P1[off + x] = r - g;
        P2[off + x] = b - g;
      } else {
        P0[off + x] = r;
        P1[off + x] = g;
        P2[off + x] = b;
      }
    }
  };
}

function makeEmit(out: Uint8Array, w: number, model: number, transform: number) {
  const alpha = modelHasAlpha(model);
  const gray = modelIsGray(model);
  return (y: number, buf: Int16Array[], off: number) => {
    let p = y * w * 4;
    let k0 = 0;
    if (alpha) {
      const A = buf[0];
      for (let x = 0; x < w; x++) out[p + x * 4 + 3] = A[off + x];
      k0 = 1;
    } else {
      for (let x = 0; x < w; x++) out[p + x * 4 + 3] = 255;
    }
    if (gray) {
      const G = buf[k0];
      for (let x = 0; x < w; x++, p += 4) {
        const v = G[off + x];
        out[p] = v;
        out[p + 1] = v;
        out[p + 2] = v;
      }
      return;
    }
    const P0 = buf[k0], P1 = buf[k0 + 1], P2 = buf[k0 + 2];
    for (let x = 0; x < w; x++, p += 4) {
      let r: number, g: number, b: number;
      if (transform === Transform.YCOCG) {
        const Y = P0[off + x], co = P1[off + x], cg = P2[off + x];
        const t = Y - (cg >> 1);
        g = cg + t;
        b = t - (co >> 1);
        r = b + co;
      } else if (transform === Transform.SUBGREEN) {
        g = P0[off + x];
        r = P1[off + x] + g;
        b = P2[off + x] + g;
      } else {
        r = P0[off + x];
        g = P1[off + x];
        b = P2[off + x];
      }
      if ((r | g | b) & ~0xff) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'colour transform produced out-of-range value');
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
    }
  };
}

/** Estimate the bit cost of each colour transform on a row subsample. */
export function chooseTransform(img: RgbaImage): Transform {
  const { width: w, height: h, data: d } = img;
  const rowStep = Math.max(1, Math.floor(h / 128));
  const colStep = Math.max(1, Math.floor(w / 512));
  const costs = [0, 0, 0];
  const LOG = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) LOG[i] = Math.log2(1 + i);
  const vals = new Int32Array(9); // 3 transforms x 3 planes
  const valsW = new Int32Array(9);
  const valsN = new Int32Array(9);
  const valsNW = new Int32Array(9);
  const tr = (p: number, o: Int32Array) => {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    o[0] = r; o[1] = g; o[2] = b;
    const co = r - b;
    const t = b + (co >> 1);
    const cg = g - t;
    o[3] = t + (cg >> 1); o[4] = co; o[5] = cg;
    o[6] = g; o[7] = r - g; o[8] = b - g;
  };
  for (let y = 1; y < h; y += rowStep) {
    for (let x = 1; x < w; x += colStep) {
      const p = (y * w + x) * 4;
      tr(p, vals);
      tr(p - 4, valsW);
      tr(p - w * 4, valsN);
      tr(p - w * 4 - 4, valsNW);
      for (let t = 0; t < 3; t++) {
        for (let c = 0; c < 3; c++) {
          const i = t * 3 + c;
          const W = valsW[i], N = valsN[i], NW = valsNW[i];
          const mx = W > N ? W : N, mn = W > N ? N : W;
          const pr = NW >= mx ? mn : NW <= mn ? mx : W + N - NW;
          const e = Math.abs(vals[i] - pr);
          costs[t] += LOG[e < 1024 ? e : 1023];
        }
      }
    }
  }
  let best = 0;
  for (let t = 1; t < 3; t++) if (costs[t] < costs[best]) best = t;
  return best as Transform;
}

export interface LosslessOptions {
  /** Enable pixel-run copies (LZ77). Best for screenshots and graphics. */
  lz?: boolean;
  /** Match-finder search depth (LZ only). */
  chain?: number;
}

/** Packed RGBA keys used by the LZ match finder. */
function pixelKeys(img: RgbaImage): Uint32Array {
  const d = img.data;
  const n = img.width * img.height;
  const keys = new Uint32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) keys[i] = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
  return keys;
}

export function encodeLossless(img: RgbaImage, model: number, transform: number, opts: LosslessOptions = {}): Uint8Array {
  if (modelIsGray(model)) transform = Transform.NONE;
  const lz = opts.lz ?? false;
  const enc = new RangeEncoder(Math.max(1024, img.width * img.height));
  encodePlanes(enc, planeSpecs(model, transform), img.width, img.height, makeFill(img, model, transform), {
    lz,
    keys: lz ? pixelKeys(img) : undefined,
    chain: opts.chain,
  });
  const body = enc.finish();
  const out = new Uint8Array(body.length + 2);
  out[0] = transform;
  out[1] = lz ? 1 : 0;
  out.set(body, 2);
  return out;
}

export function decodeLossless(payload: Uint8Array, w: number, h: number, model: number): Uint8Array {
  if (payload.length < 2) fail(SmgErrorCode.TRUNCATED, 'lossless payload too short');
  const transform = payload[0];
  const flags = payload[1];
  if (transform > 2) fail(SmgErrorCode.CORRUPT_PAYLOAD, `unknown colour transform ${transform}`);
  if (flags & ~1) fail(SmgErrorCode.CORRUPT_PAYLOAD, `unknown lossless flags ${flags}`);
  if (modelIsGray(model) && transform !== 0) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'gray image with colour transform');
  const out = new Uint8Array(w * h * 4);
  const dec = new RangeDecoder(payload, 2);
  decodePlanes(dec, planeSpecs(model, transform), w, h, makeEmit(out, w, model, transform), { lz: (flags & 1) !== 0 });
  return out;
}

export { ColorModel };

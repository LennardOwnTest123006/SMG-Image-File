/**
 * SMG-P — palette (indexed colour) codec for images with ≤ 256 distinct colours.
 *
 * Payload layout (DATA chunk, codec id 2):
 *   varint  n            number of palette entries (1..256)
 *   ...     range-coded stream:
 *             palette entries (per channel, delta-coded against the previous entry)
 *             index plane (neighbour-match cascade + explicit index)
 *
 * Each pixel index is coded as a cascade of binary decisions:
 *   = W ?   = N ?   = NE ?   = NW ?   otherwise the explicit index with a
 *   binary-tree model conditioned on the left neighbour's index (which
 *   captures recurring colour transitions such as anti-aliased edges).
 */
import { IntContexts, TreeContexts } from '../entropy/intcoder.ts';
import { Models, RangeDecoder, RangeEncoder } from '../entropy/rangecoder.ts';
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';
import { ByteReader, ByteWriter } from '../bytes.ts';
import { modelHasAlpha, modelIsGray } from '../types.ts';

export interface PaletteResult {
  /** Packed RGBA entries (r | g<<8 | b<<16 | a<<24), sorted. */
  palette: Uint32Array;
  /** One index per pixel. */
  indices: Uint8Array;
}

function luma(c: number): number {
  const r = c & 0xff, g = (c >>> 8) & 0xff, b = (c >>> 16) & 0xff, a = c >>> 24;
  return (a << 16) + (r * 2 + g * 5 + b) * 8;
}

/** Build a palette if the image has at most `maxColors` distinct colours. */
export function buildPalette(img: RgbaImage, maxColors = 256): PaletteResult | null {
  const d = img.data;
  const n = img.width * img.height;
  const map = new Map<number, number>();
  const u32 = new Uint32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const c = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
    u32[i] = c;
    if (!map.has(c)) {
      if (map.size >= maxColors) return null;
      map.set(c, 0);
    }
  }
  const palette = Uint32Array.from(map.keys()).sort((a, b) => luma(a) - luma(b) || a - b);
  palette.forEach((c, i) => map.set(c, i));
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = map.get(u32[i])!;
  return { palette, indices };
}

function treeBits(n: number): number {
  let b = 0;
  while (1 << b < n) b++;
  return Math.max(1, b);
}

const MATCH_CTX = 64 * 3;

/** Shared encode/decode routine for the index plane. */
function runIndices(
  coder: { enc: RangeEncoder; dec?: undefined } | { dec: RangeDecoder; enc?: undefined },
  idx: Uint8Array,
  w: number,
  h: number,
  n: number,
): void {
  const bits = treeBits(n);
  const eqW = new Models(MATCH_CTX);
  const eqN = new Models(MATCH_CTX);
  const eqNE = new Models(MATCH_CTX);
  const eqNW = new Models(MATCH_CTX);
  const tree = new TreeContexts(n + 1, bits);
  const encoding = coder.enc !== undefined;
  let last = 0; // 0 = matched W, 1 = matched another neighbour, 2 = explicit
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const W = x > 0 ? idx[i - 1] : -1;
      const N = y > 0 ? idx[i - w] : -1;
      const NW = x > 0 && y > 0 ? idx[i - w - 1] : -1;
      const NE = y > 0 && x < w - 1 ? idx[i - w + 1] : -1;
      const NN = y > 1 ? idx[i - 2 * w] : -1;
      const WW = x > 1 ? idx[i - 2] : -1;
      const pattern =
        (W === N ? 1 : 0) | (W === NW ? 2 : 0) | (N === NE ? 4 : 0) | (W === NE ? 8 : 0) | (N === NN ? 16 : 0) | (W === WW ? 32 : 0);
      const ctx = pattern * 3 + last;
      const v = encoding ? idx[i] : 0;
      let out = -1;

      // Cascade of neighbour matches; each candidate is tried only if distinct from earlier ones.
      if (W >= 0) {
        if (encoding) coder.enc.encode(eqW, ctx, v === W ? 1 : 0);
        if (encoding ? v === W : coder.dec!.decode(eqW, ctx)) out = W;
      }
      if (out < 0 && N >= 0 && N !== W) {
        if (encoding) coder.enc.encode(eqN, ctx, v === N ? 1 : 0);
        if (encoding ? v === N : coder.dec!.decode(eqN, ctx)) out = N;
      }
      if (out < 0 && NE >= 0 && NE !== W && NE !== N) {
        if (encoding) coder.enc.encode(eqNE, ctx, v === NE ? 1 : 0);
        if (encoding ? v === NE : coder.dec!.decode(eqNE, ctx)) out = NE;
      }
      if (out < 0 && NW >= 0 && NW !== W && NW !== N && NW !== NE) {
        if (encoding) coder.enc.encode(eqNW, ctx, v === NW ? 1 : 0);
        if (encoding ? v === NW : coder.dec!.decode(eqNW, ctx)) out = NW;
      }
      if (out >= 0) {
        last = out === W ? 0 : 1;
      } else {
        const set = W >= 0 ? W : n;
        if (encoding) {
          tree.encode(coder.enc, set, v);
          out = v;
        } else {
          out = tree.decode(coder.dec!, set);
          if (out >= n) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'palette index out of range');
        }
        last = 2;
      }
      if (!encoding) idx[i] = out;
    }
  }
}

function channelsFor(model: number): number[] {
  // Channel offsets (0=R,1=G,2=B,3=A) that are stored for each entry.
  if (modelIsGray(model)) return modelHasAlpha(model) ? [0, 3] : [0];
  return modelHasAlpha(model) ? [0, 1, 2, 3] : [0, 1, 2];
}

export function encodePalette(pal: PaletteResult, w: number, h: number, model: number): Uint8Array {
  const n = pal.palette.length;
  if (n < 1 || n > 256) fail(SmgErrorCode.INVALID_ARGUMENT, 'palette must have 1..256 entries');
  const head = new ByteWriter(8).varint(n).finish();
  const enc = new RangeEncoder(Math.max(256, (w * h) >> 2));
  const chans = channelsFor(model);
  const ints = new IntContexts(4, 9, 1);
  let prev = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = pal.palette[i];
    const ch = [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24];
    for (const k of chans) ints.encode(enc, k, ch[k] - prev[k]);
    prev = ch;
  }
  runIndices({ enc }, pal.indices, w, h, n);
  const body = enc.finish();
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export function decodePalette(payload: Uint8Array, w: number, h: number, model: number): Uint8Array {
  const r = new ByteReader(payload, 0, payload.length, 'palette payload');
  const n = r.varint();
  if (n < 1 || n > 256) fail(SmgErrorCode.CORRUPT_PAYLOAD, `invalid palette size ${n}`);
  const dec = new RangeDecoder(payload, r.pos);
  const chans = channelsFor(model);
  const gray = modelIsGray(model);
  const alpha = modelHasAlpha(model);
  const ints = new IntContexts(4, 9, 1);
  const entries = new Uint8Array(n * 4);
  const prev = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const ch = [0, 0, 0, 255];
    for (const k of chans) {
      const v = prev[k] + ints.decode(dec, k);
      if (v < 0 || v > 255) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'palette entry out of range');
      ch[k] = v;
      prev[k] = v;
    }
    if (gray) ch[1] = ch[2] = ch[0];
    if (!alpha) ch[3] = 255;
    entries.set(ch, i * 4);
  }
  const idx = new Uint8Array(w * h);
  runIndices({ dec }, idx, w, h, n);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, p = 0; i < idx.length; i++, p += 4) {
    const e = idx[i] * 4;
    out[p] = entries[e];
    out[p + 1] = entries[e + 1];
    out[p + 2] = entries[e + 2];
    out[p + 3] = entries[e + 3];
  }
  return out;
}

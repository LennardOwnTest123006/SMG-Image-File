/**
 * SMG lossless plane engine.
 *
 * Codes a set of integer sample planes (e.g. A, Y, Co, Cg) losslessly:
 *
 *   - Rows are processed in bands of T rows. For every T×T tile and plane the
 *     encoder picks one of NUM_PREDICTORS spatial predictors (minimum sum of
 *     absolute residuals) and signals the choice with a context-modelled
 *     3-bit symbol. Predictor 7 is a per-pixel blend of four sub-predictors
 *     weighted by their recent local errors.
 *   - Samples are coded pixel by pixel, plane by plane, so dependent planes
 *     can use the residual of their reference plane at the same pixel as
 *     context.
 *   - Prediction residuals are coded with the near-zero integer coder. The
 *     context set is chosen from local gradient activity, the magnitude of
 *     neighbouring residuals, and the reference-plane residual.
 *   - A per-context bias canceller (in the spirit of LOCO-I / JPEG-LS) learns
 *     and removes systematic prediction offsets.
 *   - Optional LZ mode: before each pixel a flag says whether a run of whole
 *     pixels is copied from an earlier position (distance in pixels, with a
 *     4-entry recent-distance cache and 2-D explicit distances). This captures
 *     repeated glyphs and UI elements in screenshots and graphics.
 *
 * Encoder and decoder run the *same* function (`runPlanes`) so the context
 * derivation cannot diverge.
 */
import { IntContexts, TreeContexts } from '../entropy/intcoder.ts';
import { Models, type RangeDecoder, type RangeEncoder } from '../entropy/rangecoder.ts';
import { fail, SmgErrorCode } from '../errors.ts';

export interface PlaneSpec {
  /** Minimum sample value. */
  min: number;
  /** Maximum sample value. */
  max: number;
  /** Index of an earlier plane whose residual is used as context, or -1. */
  ref: number;
}

export interface PlaneOptions {
  /** Pixel-level LZ77 matching (stored in the stream; decoder must agree). */
  lz: boolean;
  /** Encoder only (LZ mode): one 32-bit key per pixel identifying its exact value. */
  keys?: Uint32Array;
  /** Encoder only: hash-chain search depth. */
  chain?: number;
}

export const NUM_PREDICTORS = 8;
const BLEND = 7;
const NS = 4; // sub-predictors used by the blended predictor
export const TILE = 32;

const ACT_BUCKETS = 12;
const REF_BUCKETS = 4;
const SETS_PER_PLANE = ACT_BUCKETS * REF_BUCKETS;
const EMAX = 11; // |residual| < 2048
const BIAS_CTX = 9 * 9 * 3 * ACT_BUCKETS;

export const MIN_MATCH = 3;
const MAX_MATCH = 65535 + MIN_MATCH;
const HASH_BITS = 18;
const CACHE_BITS = 8;
const CACHE_SIZE = 1 << CACHE_BITS;

const ACT_Q = (() => {
  const t = new Uint8Array(4096);
  const thresholds = [0, 1, 3, 5, 8, 12, 18, 27, 40, 60, 95];
  for (let v = 0; v < 4096; v++) {
    let b = 0;
    while (b < thresholds.length && v > thresholds[b]) b++;
    t[v] = Math.min(ACT_BUCKETS - 1, b);
  }
  return t;
})();

function qact(v: number): number {
  return v < 4096 ? ACT_Q[v] : ACT_BUCKETS - 1;
}

function qref(v: number): number {
  return v === 0 ? 0 : v <= 2 ? 1 : v <= 8 ? 2 : 3;
}

/** Quantise a signed gradient to 9 levels (-4..4) for the bias context. */
function qgrad(d: number): number {
  if (d === 0) return 4;
  const a = d < 0 ? -d : d;
  const l = a <= 2 ? 1 : a <= 6 ? 2 : a <= 20 ? 3 : 4;
  return d < 0 ? 4 - l : 4 + l;
}

function predictValue(p: number, W: number, N: number, NW: number, NE: number, WW: number, NN: number): number {
  switch (p) {
    case 0: {
      // Median edge detector (LOCO-I).
      const mx = W > N ? W : N;
      const mn = W > N ? N : W;
      if (NW >= mx) return mn;
      if (NW <= mn) return mx;
      return W + N - NW;
    }
    case 1:
      return (W + N + 1) >> 1;
    case 2:
      return W;
    case 3:
      return N;
    case 4:
      return W + N - NW;
    case 5:
      return (W + NE + 1) >> 1;
    case 6: {
      // Gradient-adjusted (simplified CALIC GAP).
      const dh = Math.abs(W - WW) + Math.abs(N - NW) + Math.abs(N - NE);
      const dv = Math.abs(W - NW) + Math.abs(N - NN);
      if (dv - dh > 32) return W;
      if (dh - dv > 32) return N;
      const pr = ((W + N) * 2 + (NE - NW)) >> 2;
      if (dv - dh > 8) return (pr + W + 1) >> 1;
      if (dh - dv > 8) return (pr + N + 1) >> 1;
      return pr;
    }
    default:
      return W;
  }
}

const WT_SIZE = 16384;
const WEIGHTS = (() => {
  const t = new Float64Array(WT_SIZE);
  for (let s = 1; s < WT_SIZE; s++) t[s] = Math.floor(16777216 / (s * s)) + 1;
  return t;
})();

function weight(s: number): number {
  return s < WT_SIZE ? WEIGHTS[s] : 1;
}

/**
 * Blended predictor: a weighted mean of the sub-predictors (W+N−NW, W, N, NE),
 * each weighted by the inverse square of its recent absolute error at the W,
 * N, NW and NE neighbours. `E` holds per-pixel sub-predictor errors.
 */
function blendPredict(E: Uint16Array, idx: number, w: number, x: number, y: number, W: number, N: number, NW: number, NE: number): number {
  let s0 = 1, s1 = 1, s2 = 1, s3 = 1;
  if (x > 0) {
    const o = (idx - 1) * NS;
    s0 += 2 * E[o]; s1 += 2 * E[o + 1]; s2 += 2 * E[o + 2]; s3 += 2 * E[o + 3];
  }
  if (y > 0) {
    let o = (idx - w) * NS;
    s0 += 2 * E[o]; s1 += 2 * E[o + 1]; s2 += 2 * E[o + 2]; s3 += 2 * E[o + 3];
    if (x > 0) {
      o = (idx - w - 1) * NS;
      s0 += E[o]; s1 += E[o + 1]; s2 += E[o + 2]; s3 += E[o + 3];
    }
    if (x < w - 1) {
      o = (idx - w + 1) * NS;
      s0 += E[o]; s1 += E[o + 1]; s2 += E[o + 2]; s3 += E[o + 3];
    }
  }
  const w0 = weight(s0), w1 = weight(s1), w2 = weight(s2), w3 = weight(s3);
  const den = w0 + w1 + w2 + w3;
  const num = w0 * (W + N - NW) + w1 * W + w2 * N + w3 * NE;
  return Math.floor((num + Math.floor(den / 2)) / den);
}

function storeSubErr(E: Uint16Array, idx: number, v: number, W: number, N: number, NW: number, NE: number): void {
  const o = idx * NS;
  let d = v - (W + N - NW);
  E[o] = d < 0 ? -d : d;
  d = v - W;
  E[o + 1] = d < 0 ? -d : d;
  d = v - N;
  E[o + 2] = d < 0 ? -d : d;
  d = v - NE;
  E[o + 3] = d < 0 ? -d : d;
}

type Coder = { enc: RangeEncoder; dec?: undefined } | { dec: RangeDecoder; enc?: undefined };

/**
 * Fills (encoder) or receives (decoder) plane rows. `buf[k]` is plane k's
 * buffer; row data for image row `y` lives at `buf[k][offset .. offset+width)`.
 */
export type RowFill = (y: number, buf: Int16Array[], offset: number) => void;

/** Rough bit cost of a residual magnitude (used only for encoder decisions). */
const COST = (() => {
  const t = new Float32Array(1024);
  t[0] = 0.12;
  for (let e = 1; e < 1024; e++) t[e] = 2.4 + 1.5 * Math.log2(e);
  return t;
})();

/** Encoder-side LZ77 match finder over packed pixel keys. */
class MatchFinder {
  private readonly head: Int32Array;
  private readonly prev: Int32Array;
  /** Prefix sums of the estimated literal cost per pixel. */
  private readonly pre: Float64Array;
  constructor(
    private readonly keys: Uint32Array,
    private readonly w: number,
    private readonly chain: number,
  ) {
    const n = keys.length;
    this.head = new Int32Array(1 << HASH_BITS).fill(-1);
    this.prev = new Int32Array(n);
    this.pre = new Float64Array(n + 1);
    // Literal cost estimate: MED residual of each 8-bit channel.
    for (let i = 0; i < n; i++) {
      const x = i % w;
      const k = keys[i];
      const kw = x > 0 ? keys[i - 1] : i >= w ? keys[i - w] : 0;
      const kn = i >= w ? keys[i - w] : kw;
      const knw = x > 0 && i >= w ? keys[i - w - 1] : kn;
      let c = 0;
      for (let s = 0; s < 32; s += 8) {
        const v = (k >>> s) & 255, W = (kw >>> s) & 255, N = (kn >>> s) & 255, NW = (knw >>> s) & 255;
        const mx = W > N ? W : N, mn = W > N ? N : W;
        const p = NW >= mx ? mn : NW <= mn ? mx : W + N - NW;
        const e = v - p;
        c += COST[e < 0 ? -e : e];
      }
      this.pre[i + 1] = this.pre[i] + c;
    }
  }

  private hash(i: number): number {
    const k = this.keys;
    return (Math.imul(k[i], 0x9e3779b1) ^ Math.imul(k[i + 1], 0x85ebca77) ^ Math.imul(k[i + 2], 0xc2b2ae3d)) >>> (32 - HASH_BITS);
  }

  /** Estimated literal cost of pixel i (bits). */
  literalCost(i: number): number {
    return this.pre[i + 1] - this.pre[i];
  }

  insert(i: number): void {
    if (i + 2 >= this.keys.length) return;
    const h = this.hash(i);
    this.prev[i] = this.head[h];
    this.head[h] = i;
  }

  private matchLen(i: number, j: number, max: number): number {
    const k = this.keys;
    let l = 0;
    while (l < max && k[i + l] === k[j + l]) l++;
    return l;
  }

  private distCost(d: number, repIdx: number): number {
    if (repIdx >= 0) return 2 + repIdx * 0.5;
    const dy = Math.floor((d + (this.w >> 1)) / this.w);
    const dx = d - dy * this.w;
    return 4 + 2 * Math.log2(dy + 1) + 2 * Math.log2(Math.abs(dx) + 1) + 1;
  }

  /** Best match at i as [distance, length, repIndex] or null. */
  find(i: number, reps: Int32Array): [number, number, number] | null {
    const n = this.keys.length;
    const max = Math.min(MAX_MATCH, n - i);
    if (max < MIN_MATCH) return null;
    // Cheap literal coming up? Then do not bother.
    if (this.pre[Math.min(n, i + 4)] - this.pre[i] < 1.5) return null;
    let bestGain = 1.5;
    let best: [number, number, number] | null = null;
    const consider = (d: number, rep: number) => {
      if (d < 1 || d > i) return;
      const len = this.matchLen(i, i - d, max);
      if (len < MIN_MATCH) return;
      const gain = this.pre[i + len] - this.pre[i] - (1 + this.distCost(d, rep) + 2 * Math.log2(len - MIN_MATCH + 1) + 1);
      if (gain > bestGain) {
        bestGain = gain;
        best = [d, len, rep];
      }
    };
    for (let r = 0; r < 4; r++) consider(reps[r], r);
    if (i + 2 < n) {
      let j = this.head[this.hash(i)];
      for (let steps = 0; j >= 0 && steps < this.chain; steps++) {
        const d = i - j;
        let rep = -1;
        for (let r = 0; r < 4; r++) if (reps[r] === d) rep = r;
        if (rep < 0) consider(d, -1);
        j = this.prev[j];
      }
    }
    return best;
  }
}

function runPlanes(coder: Coder, specs: PlaneSpec[], w: number, h: number, io: RowFill, opts: PlaneOptions): void {
  const np = specs.length;
  const T = TILE;
  const encoding = coder.enc !== undefined;
  const lz = opts.lz;
  const n = w * h;
  // Plane buffers: whole image (+2 rows) in LZ mode, else a rolling band.
  const rowsAlloc = lz ? h + 2 : T + 2;
  const band = specs.map(() => new Int16Array(rowsAlloc * w));
  const subErr = specs.map(() => new Uint16Array((T + 2) * w * NS));
  const errPrev = specs.map(() => new Int32Array(w));
  const errCur = specs.map(() => new Int32Array(w));
  const ints = new IntContexts(np * SETS_PER_PLANE, EMAX, 3);
  const predTree = new TreeContexts(np * (NUM_PREDICTORS + 1), 3);
  const tilesX = Math.ceil(w / T);
  const choice = new Uint8Array(np * tilesX);
  const prevBandChoice = new Uint8Array(np * tilesX).fill(NUM_PREDICTORS);
  const biasSum = specs.map(() => new Int32Array(BIAS_CTX));
  const biasCnt = specs.map(() => new Int32Array(BIAS_CTX));
  const tileCost = new Float64Array(tilesX * NUM_PREDICTORS);
  const rowOff = (y: number, y0: number) => (lz ? y + 2 : y - y0 + 2) * w;

  // LZ state
  const matchFlag = new Models(12);
  const kindTree = new TreeContexts(6, 3);
  const distInts = new IntContexts(3, 24, 1);
  const lenInts = new IntContexts(2, 17, 1);
  const reps = new Int32Array([1, w, w + 1, Math.max(1, w - 1)]);
  const covPrev = new Uint8Array(w);
  const covCur = new Uint8Array(w);
  let copyLeft = 0;
  let copyDist = 0;
  let lastKind = 5;
  const finder = encoding && lz ? new MatchFinder(opts.keys!, w, opts.chain ?? 24) : null;
  // Colour cache (LZ mode): recently seen pixel values, addressed by hash.
  const cacheVals = specs.map(() => new Int16Array(CACHE_SIZE));
  const cacheUsed = new Uint8Array(CACHE_SIZE);
  const cacheFlag = new Models(24);
  const cacheTree = new TreeContexts(3, CACHE_BITS);
  const hitPrev = new Uint8Array(w);
  const hitCur = new Uint8Array(w);
  const curVals = new Int32Array(np);
  const pixelHash = (vals: Int32Array | Int16Array[], at: number): number => {
    let h = 0x811c9dc5;
    for (let k = 0; k < np; k++) {
      const v = Array.isArray(vals) ? (vals as Int16Array[])[k][at] : (vals as Int32Array)[k];
      h = Math.imul(h ^ (v & 0xffff), 0x1e35a7bd);
    }
    return (h ^ (h >>> 15)) >>> (32 - CACHE_BITS);
  };
  if (encoding && lz) {
    if (!opts.keys || opts.keys.length !== n) fail(SmgErrorCode.INVALID_ARGUMENT, 'LZ mode requires pixel keys');
    for (let y = 0; y < h; y++) io(y, band, rowOff(y, 0));
  }

  for (let y0 = 0; y0 < h; y0 += T) {
    const rows = Math.min(T, h - y0);
    if (y0 > 0) {
      for (let k = 0; k < np; k++) {
        if (!lz) band[k].copyWithin(0, T * w, (T + 2) * w);
        subErr[k].copyWithin(0, T * w * NS, (T + 2) * w * NS);
      }
    }
    if (encoding && !lz) for (let r = 0; r < rows; r++) io(y0 + r, band, rowOff(y0 + r, y0));

    // ---- predictor selection (encoder) / reading (decoder) ----
    for (let k = 0; k < np; k++) {
      const P = band[k];
      if (encoding) {
        const E = new Uint16Array(subErr[k]); // scratch copy: pre-pass must not disturb state
        tileCost.fill(0);
        for (let r = 0; r < rows; r++) {
          const y = y0 + r;
          const base = rowOff(y, y0);
          const sb = (r + 2) * w;
          for (let x = 0; x < w; x++) {
            const N = y > 0 ? P[base - w + x] : x > 0 ? P[base + x - 1] : 0;
            const W = x > 0 ? P[base + x - 1] : N;
            const NW = x > 0 && y > 0 ? P[base - w + x - 1] : N;
            const NE = y > 0 && x < w - 1 ? P[base - w + x + 1] : N;
            const WW = x > 1 ? P[base + x - 2] : W;
            const NN = y > 1 ? P[base - 2 * w + x] : N;
            const v = P[base + x];
            const tc = ((x / T) | 0) * NUM_PREDICTORS;
            for (let p = 0; p < BLEND; p++) {
              const d = v - predictValue(p, W, N, NW, NE, WW, NN);
              tileCost[tc + p] += d < 0 ? -d : d;
            }
            const db = v - blendPredict(E, sb + x, w, x, y, W, N, NW, NE);
            tileCost[tc + BLEND] += db < 0 ? -db : db;
            storeSubErr(E, sb + x, v, W, N, NW, NE);
          }
        }
      }
      for (let tx = 0; tx < tilesX; tx++) {
        const ctxSet = k * (NUM_PREDICTORS + 1) + (tx > 0 ? choice[k * tilesX + tx - 1] : prevBandChoice[k * tilesX + tx]);
        let best = 0;
        if (encoding) {
          const tc = tx * NUM_PREDICTORS;
          const prefer = ctxSet % (NUM_PREDICTORS + 1);
          if (prefer < NUM_PREDICTORS) tileCost[tc + prefer] *= 0.985;
          for (let p = 1; p < NUM_PREDICTORS; p++) if (tileCost[tc + p] < tileCost[tc + best]) best = p;
          predTree.encode(coder.enc, ctxSet, best);
        } else {
          best = predTree.decode(coder.dec!, ctxSet);
          if (best >= NUM_PREDICTORS) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid predictor index');
        }
        choice[k * tilesX + tx] = best;
      }
    }
    prevBandChoice.set(choice);

    // ---- pixel coding ----
    for (let r = 0; r < rows; r++) {
      const y = y0 + r;
      const base = rowOff(y, y0);
      const sbase = (r + 2) * w;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (lz && copyLeft === 0) {
          // Match flag context: was W / N copied, and local activity of plane 0.
          const P0 = band[0];
          const N0 = y > 0 ? P0[base - w + x] : x > 0 ? P0[base + x - 1] : 0;
          const W0 = x > 0 ? P0[base + x - 1] : N0;
          const NW0 = x > 0 && y > 0 ? P0[base - w + x - 1] : N0;
          const NE0 = y > 0 && x < w - 1 ? P0[base - w + x + 1] : N0;
          const a = Math.abs(W0 - NW0) + Math.abs(N0 - NW0) + Math.abs(N0 - NE0);
          const fctx = (x > 0 ? covCur[x - 1] : 0) + 2 * (y > 0 ? covPrev[x] : 0) + 4 * (a === 0 ? 0 : a <= 12 ? 1 : 2);
          let m: [number, number, number] | null = null;
          if (encoding) {
            m = finder!.find(i, reps);
            coder.enc.encode(matchFlag, fctx, m ? 1 : 0);
          }
          const isMatch = encoding ? m !== null : coder.dec!.decode(matchFlag, fctx) === 1;
          if (isMatch) {
            let kind: number;
            let d: number;
            let len: number;
            if (encoding) {
              [d, len] = m!;
              kind = m![2] >= 0 ? m![2] : 4;
              kindTree.encode(coder.enc, lastKind, kind);
              if (kind === 4) {
                const dy = Math.floor((d + (w >> 1)) / w);
                distInts.encode(coder.enc, 0, dy);
                distInts.encode(coder.enc, dy === 0 ? 1 : 2, d - dy * w);
              }
              lenInts.encode(coder.enc, kind === 4 ? 1 : 0, len - MIN_MATCH);
            } else {
              kind = kindTree.decode(coder.dec!, lastKind);
              if (kind > 4) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid match kind');
              if (kind === 4) {
                const dy = distInts.decode(coder.dec!, 0);
                if (dy < 0) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid match distance');
                d = dy * w + distInts.decode(coder.dec!, dy === 0 ? 1 : 2);
              } else d = reps[kind];
              len = lenInts.decode(coder.dec!, kind === 4 ? 1 : 0) + MIN_MATCH;
              if (len < MIN_MATCH || len > MAX_MATCH || i + len > n) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid match length');
              if (d < 1 || d > i) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'invalid match distance');
            }
            // Update the recent-distance cache (move to front).
            const from = kind === 4 ? 3 : kind;
            for (let q = from; q > 0; q--) reps[q] = reps[q - 1];
            reps[0] = d;
            lastKind = kind;
            copyLeft = len;
            copyDist = d;
          }
        }
        const copying = copyLeft > 0;
        let srcOff = 0;
        if (copying && !encoding) {
          const s = i - copyDist;
          srcOff = rowOff((s / w) | 0, y0) + (s % w);
        }
        // Colour-cache hit (LZ mode, literal pixels only).
        let hit = false;
        if (lz && !copying) {
          const P0 = band[0];
          const N0 = y > 0 ? P0[base - w + x] : x > 0 ? P0[base + x - 1] : 0;
          const W0 = x > 0 ? P0[base + x - 1] : N0;
          const NW0 = x > 0 && y > 0 ? P0[base - w + x - 1] : N0;
          const NE0 = y > 0 && x < w - 1 ? P0[base - w + x + 1] : N0;
          const a = Math.abs(W0 - NW0) + Math.abs(N0 - NW0) + Math.abs(N0 - NE0);
          const hctx = (x > 0 ? hitCur[x - 1] : 0) + 2 * (y > 0 ? hitPrev[x] : 0) + 4 * (a === 0 ? 0 : a <= 4 ? 1 : a <= 16 ? 2 : a <= 48 ? 3 : a <= 120 ? 4 : 5);
          const tctx = (x > 0 ? hitCur[x - 1] : 0) + (y > 0 ? hitPrev[x] : 0);
          if (encoding) {
            const hsh = pixelHash(band, base + x);
            let same = cacheUsed[hsh] === 1;
            for (let k = 0; k < np && same; k++) if (cacheVals[k][hsh] !== band[k][base + x]) same = false;
            hit = same && finder!.literalCost(i) > CACHE_BITS + 1.5;
            coder.enc.encode(cacheFlag, hctx, hit ? 1 : 0);
            if (hit) cacheTree.encode(coder.enc, tctx, hsh);
          } else if (coder.dec!.decode(cacheFlag, hctx)) {
            const hsh = cacheTree.decode(coder.dec!, tctx);
            if (!cacheUsed[hsh]) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'reference to empty colour-cache slot');
            for (let k = 0; k < np; k++) band[k][base + x] = cacheVals[k][hsh];
            hit = true;
          }
        }
        for (let k = 0; k < np; k++) {
          const P = band[k];
          const spec = specs[k];
          const eP = errPrev[k];
          const eC = errCur[k];
          const N = y > 0 ? P[base - w + x] : x > 0 ? P[base + x - 1] : 0;
          const W = x > 0 ? P[base + x - 1] : N;
          const NW = x > 0 && y > 0 ? P[base - w + x - 1] : N;
          const NE = y > 0 && x < w - 1 ? P[base - w + x + 1] : N;
          const WW = x > 1 ? P[base + x - 2] : W;
          const NN = y > 1 ? P[base - 2 * w + x] : N;

          const eW = x > 0 ? eC[x - 1] : y > 0 ? eP[x] : 0;
          const eN = y > 0 ? eP[x] : eW;
          const eNW = y > 0 && x > 0 ? eP[x - 1] : eN;
          const eNE = y > 0 && x < w - 1 ? eP[x + 1] : eN;

          const pid = choice[k * tilesX + ((x / T) | 0)];
          const rawPred = pid === BLEND ? blendPredict(subErr[k], sbase + x, w, x, y, W, N, NW, NE) : predictValue(pid, W, N, NW, NE, WW, NN);
          let pred = rawPred;

          const dA = N - NW;
          const dB = W - NW;
          const dC = NE - N;
          const act = (dA < 0 ? -dA : dA) + (dB < 0 ? -dB : dB) + (dC < 0 ? -dC : dC);
          const errSum = eW + eN + ((eNW + eNE) >> 1);
          const aq = qact((act + errSum * 2) >> 1);

          const bctx = ((qgrad(dA) * 9 + qgrad(dB)) * 3 + (dC > 0 ? 2 : dC < 0 ? 0 : 1)) * ACT_BUCKETS + aq;
          const bS = biasSum[k];
          const bC = biasCnt[k];
          const cnt = bC[bctx];
          if (cnt > 0) {
            const s = bS[bctx];
            pred += s >= 0 ? ((s + (cnt >> 1)) / cnt) | 0 : -(((-s + (cnt >> 1)) / cnt) | 0);
          }
          if (pred < spec.min) pred = spec.min;
          else if (pred > spec.max) pred = spec.max;

          let v: number;
          let res: number;
          if (copying || hit) {
            v = copying && !encoding ? P[srcOff] : P[base + x];
            P[base + x] = v;
            res = v - pred;
          } else {
            const rq = spec.ref >= 0 ? qref(errCur[spec.ref][x]) : 0;
            const set = k * SETS_PER_PLANE + aq * REF_BUCKETS + rq;
            const sv = bS[bctx];
            const signCtx = sv > 0 ? 2 : sv < 0 ? 0 : 1;
            if (encoding) {
              v = P[base + x];
              res = v - pred;
              ints.encode(coder.enc, set, res, signCtx);
            } else {
              res = ints.decode(coder.dec!, set, signCtx);
              v = pred + res;
              if (v < spec.min || v > spec.max) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'decoded sample out of range');
              P[base + x] = v;
            }
          }
          eC[x] = res < 0 ? -res : res;
          storeSubErr(subErr[k], sbase + x, v, W, N, NW, NE);

          // Bias statistics track the error of the *uncorrected* predictor.
          let e = v - rawPred;
          if (e > 255) e = 255;
          else if (e < -255) e = -255;
          bS[bctx] += e;
          if (cnt + 1 >= 64) {
            bS[bctx] = bS[bctx] >> 1;
            bC[bctx] = (cnt + 1) >> 1;
          } else bC[bctx] = cnt + 1;
        }
        if (lz) {
          covCur[x] = copying ? 1 : 0;
          hitCur[x] = hit ? 1 : 0;
          if (copying) copyLeft--;
          if (finder) finder.insert(i);
          for (let k = 0; k < np; k++) curVals[k] = band[k][base + x];
          const hsh = pixelHash(curVals, 0);
          for (let k = 0; k < np; k++) cacheVals[k][hsh] = curVals[k];
          cacheUsed[hsh] = 1;
        }
      }
      if (!encoding) io(y, band, base);
      for (let k = 0; k < np; k++) {
        const t = errPrev[k];
        errPrev[k] = errCur[k];
        errCur[k] = t;
      }
      if (lz) {
        covPrev.set(covCur);
        hitPrev.set(hitCur);
      }
    }
  }
  if (copyLeft !== 0) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'match extends past the end of the image');
}

export function encodePlanes(enc: RangeEncoder, specs: PlaneSpec[], w: number, h: number, fill: RowFill, opts: PlaneOptions = { lz: false }): void {
  runPlanes({ enc }, specs, w, h, fill, opts);
}

export function decodePlanes(dec: RangeDecoder, specs: PlaneSpec[], w: number, h: number, emit: RowFill, opts: PlaneOptions = { lz: false }): void {
  runPlanes({ dec }, specs, w, h, emit, opts);
}

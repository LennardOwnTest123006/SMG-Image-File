/**
 * 2-D Cohen–Daubechies–Feauveau 9/7 wavelet transform (lifting scheme) with
 * whole-sample symmetric extension and Mallat (dyadic) sub-band layout.
 *
 * Scaling uses ζ = 1.149604398 so that the transform is close to
 * orthonormal: a uniform quantiser step yields roughly uniform MSE across
 * sub-bands.
 */

const A = -1.586134342059924;
const B = -0.052980118572961;
const C = 0.882911075530934;
const D = 0.443506852043971;
const Z = 1.149604398;

function lift(t: Float64Array, n: number, start: number, coef: number): void {
  for (let i = start; i < n; i += 2) {
    const l = i > 0 ? t[i - 1] : t[i + 1];
    const r = i + 1 < n ? t[i + 1] : t[i - 1];
    t[i] += coef * (l + r);
  }
}

export function fwd1d(t: Float64Array, n: number): void {
  if (n < 2) return;
  lift(t, n, 1, A);
  lift(t, n, 0, B);
  lift(t, n, 1, C);
  lift(t, n, 0, D);
  for (let i = 0; i < n; i++) t[i] = i & 1 ? t[i] / Z : t[i] * Z;
}

export function inv1d(t: Float64Array, n: number): void {
  if (n < 2) return;
  for (let i = 0; i < n; i++) t[i] = i & 1 ? t[i] * Z : t[i] / Z;
  lift(t, n, 0, -D);
  lift(t, n, 1, -C);
  lift(t, n, 0, -B);
  lift(t, n, 1, -A);
}

export interface Subband {
  /** 0 = LL (only at the coarsest level), 1 = HL, 2 = LH, 3 = HH */
  orient: number;
  /** 1 = finest. LL carries level = levels. */
  level: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Choose the number of decomposition levels for a plane. */
export function levelsFor(w: number, h: number): number {
  let l = 0;
  let cw = w, ch = h;
  while (l < 6 && Math.min(cw, ch) > 12) {
    cw = Math.ceil(cw / 2);
    ch = Math.ceil(ch / 2);
    l++;
  }
  return l;
}

/** Sub-band rectangles in coding order: LL, then (HL, LH, HH) from coarsest to finest. */
export function subbands(w: number, h: number, levels: number): Subband[] {
  const dims: Array<[number, number]> = [[w, h]];
  for (let l = 1; l <= levels; l++) {
    const [pw, ph] = dims[l - 1];
    dims.push([Math.ceil(pw / 2), Math.ceil(ph / 2)]);
  }
  const out: Subband[] = [];
  const [lw, lh] = dims[levels];
  out.push({ orient: 0, level: levels, x0: 0, y0: 0, w: lw, h: lh });
  for (let l = levels; l >= 1; l--) {
    const [cw, ch] = dims[l - 1];
    const [hw, hh] = dims[l];
    out.push({ orient: 1, level: l, x0: hw, y0: 0, w: cw - hw, h: hh });
    out.push({ orient: 2, level: l, x0: 0, y0: hh, w: hw, h: ch - hh });
    out.push({ orient: 3, level: l, x0: hw, y0: hh, w: cw - hw, h: ch - hh });
  }
  return out;
}

export function forward2d(plane: Float32Array, w: number, h: number, levels: number): void {
  const t = new Float64Array(Math.max(w, h));
  const tmp = new Float64Array(Math.max(w, h));
  let cw = w, ch = h;
  for (let l = 0; l < levels; l++) {
    const lw = Math.ceil(cw / 2);
    const lh = Math.ceil(ch / 2);
    // rows
    for (let y = 0; y < ch; y++) {
      const o = y * w;
      for (let x = 0; x < cw; x++) t[x] = plane[o + x];
      fwd1d(t, cw);
      for (let x = 0; x < cw; x++) tmp[(x & 1 ? lw : 0) + (x >> 1)] = t[x];
      for (let x = 0; x < cw; x++) plane[o + x] = tmp[x];
    }
    // columns
    for (let x = 0; x < cw; x++) {
      for (let y = 0; y < ch; y++) t[y] = plane[y * w + x];
      fwd1d(t, ch);
      for (let y = 0; y < ch; y++) tmp[(y & 1 ? lh : 0) + (y >> 1)] = t[y];
      for (let y = 0; y < ch; y++) plane[y * w + x] = tmp[y];
    }
    cw = lw;
    ch = lh;
  }
}

export function inverse2d(plane: Float32Array, w: number, h: number, levels: number): void {
  const dims: Array<[number, number]> = [[w, h]];
  for (let l = 1; l <= levels; l++) dims.push([Math.ceil(dims[l - 1][0] / 2), Math.ceil(dims[l - 1][1] / 2)]);
  const t = new Float64Array(Math.max(w, h));
  for (let l = levels; l >= 1; l--) {
    const [cw, ch] = dims[l - 1];
    const lw = dims[l][0];
    const lh = dims[l][1];
    // columns
    for (let x = 0; x < cw; x++) {
      for (let y = 0; y < ch; y++) {
        const src = y < lh ? y * 2 : (y - lh) * 2 + 1;
        t[src] = plane[y * w + x];
      }
      inv1d(t, ch);
      for (let y = 0; y < ch; y++) plane[y * w + x] = t[y];
    }
    // rows
    for (let y = 0; y < ch; y++) {
      const o = y * w;
      for (let x = 0; x < cw; x++) {
        const src = x < lw ? x * 2 : (x - lw) * 2 + 1;
        t[src] = plane[o + x];
      }
      inv1d(t, cw);
      for (let x = 0; x < cw; x++) plane[o + x] = t[x];
    }
  }
}

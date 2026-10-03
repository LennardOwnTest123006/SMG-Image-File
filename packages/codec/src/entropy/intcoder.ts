/**
 * Context-modelled signed integer coding ("near-zero" binarisation).
 *
 * A value v is coded as:
 *   1. zero flag            — is v == 0?
 *   2. sign                 — is v < 0?          (one of `nsign` sign contexts)
 *   3. exponent e (unary)   — e = floor(log2|v|), one context per (sign, i)
 *   4. mantissa             — the e bits below the leading one, MSB first,
 *                             one context per (e, bit position)
 *
 * Each "context set" is a contiguous group of binary models; callers pick the
 * set from local image statistics so that, e.g., flat regions and busy
 * regions learn separate statistics.
 */
import { fail, SmgErrorCode } from '../errors.ts';
import { Models, type RangeDecoder, type RangeEncoder } from './rangecoder.ts';

export class IntContexts {
  readonly models: Models;
  readonly setSize: number;
  private readonly signBase: number;
  private readonly expBase: number;
  private readonly mantBase: number;
  readonly maxAbs: number;

  /**
   * @param sets   number of context sets
   * @param emax   number of representable exponents (|v| < 2^emax)
   * @param nsign  number of sign contexts per set
   */
  constructor(
    readonly sets: number,
    readonly emax: number,
    readonly nsign = 1,
  ) {
    this.signBase = 1;
    this.expBase = 1 + nsign;
    this.mantBase = this.expBase + 2 * emax;
    this.setSize = this.mantBase + emax * emax;
    this.models = new Models(sets * this.setSize);
    this.maxAbs = 2 ** emax - 1;
  }

  encode(enc: RangeEncoder, set: number, v: number, signCtx = 0): void {
    const m = this.models;
    const base = set * this.setSize;
    if (v === 0) {
      enc.encode(m, base, 1);
      return;
    }
    enc.encode(m, base, 0);
    const neg = v < 0 ? 1 : 0;
    enc.encode(m, base + this.signBase + signCtx, neg);
    const a = neg ? -v : v;
    if (a > this.maxAbs) fail(SmgErrorCode.INVALID_ARGUMENT, `value ${v} out of range for integer coder`);
    const e = 31 - Math.clz32(a);
    const eb = base + this.expBase + neg * this.emax;
    for (let i = 0; i < e; i++) enc.encode(m, eb + i, 1);
    if (e < this.emax - 1) enc.encode(m, eb + e, 0);
    const mb = base + this.mantBase + e * this.emax;
    for (let j = e - 1; j >= 0; j--) enc.encode(m, mb + j, (a >>> j) & 1);
  }

  decode(dec: RangeDecoder, set: number, signCtx = 0): number {
    const m = this.models;
    const base = set * this.setSize;
    if (dec.decode(m, base)) return 0;
    const neg = dec.decode(m, base + this.signBase + signCtx);
    const eb = base + this.expBase + neg * this.emax;
    let e = 0;
    while (e < this.emax - 1 && dec.decode(m, eb + e)) e++;
    const mb = base + this.mantBase + e * this.emax;
    let a = 1;
    for (let j = e - 1; j >= 0; j--) a = (a << 1) | dec.decode(m, mb + j);
    return neg ? -a : a;
  }
}

/** Code a small unsigned integer in [0, 2^bits) with a binary-tree context model. */
export class TreeContexts {
  readonly models: Models;
  constructor(
    readonly sets: number,
    readonly bits: number,
  ) {
    this.models = new Models(sets << bits);
  }

  encode(enc: RangeEncoder, set: number, v: number): void {
    const base = set << this.bits;
    let node = 1;
    for (let k = this.bits - 1; k >= 0; k--) {
      const bit = (v >>> k) & 1;
      enc.encode(this.models, base + node, bit);
      node = (node << 1) | bit;
    }
  }

  decode(dec: RangeDecoder, set: number): number {
    const base = set << this.bits;
    let node = 1;
    for (let k = 0; k < this.bits; k++) node = (node << 1) | dec.decode(this.models, base + node);
    return node - (1 << this.bits);
  }
}

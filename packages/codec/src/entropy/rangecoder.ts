/**
 * Adaptive binary range coder.
 *
 * - 32-bit range, byte-wise renormalisation with carry propagation
 *   (the classic "cache + cacheSize" scheme popularised by LZMA).
 * - 16-bit probabilities. Each context keeps two estimates that adapt at a
 *   fast and a slow rate; the coding probability is their average. A small
 *   per-context counter makes young contexts adapt quickly ("warm-up").
 *
 * The exact arithmetic here is normative for SMG bitstreams: encoder and
 * decoder must produce identical probability updates. See docs/SPEC.md §6.
 */
import { fail, SmgErrorCode } from '../errors.ts';

const TOP = 1 << 24;
const PROB_INIT = 32768;
const PROB_MIN = 24;
const PROB_MAX = 65536 - 24;
const FAST_LIMIT = 5;
const SLOW_LIMIT = 7;

/** A bank of adaptive binary contexts. `p` estimates P(bit = 1) in 1/65536 units. */
export class Models {
  readonly fast: Uint16Array;
  readonly slow: Uint16Array;
  readonly n: Uint8Array;
  constructor(readonly size: number) {
    this.fast = new Uint16Array(size).fill(PROB_INIT);
    this.slow = new Uint16Array(size).fill(PROB_INIT);
    this.n = new Uint8Array(size);
  }
}

function prob(m: Models, i: number): number {
  let p = (m.fast[i] + m.slow[i]) >>> 1;
  if (p < PROB_MIN) p = PROB_MIN;
  else if (p > PROB_MAX) p = PROB_MAX;
  return p;
}

function update(m: Models, i: number, bit: number): void {
  const n = m.n[i];
  const rf = n < FAST_LIMIT ? n + 1 : FAST_LIMIT;
  const rs = n < SLOW_LIMIT ? n + 1 : SLOW_LIMIT;
  if (n < 255) m.n[i] = n + 1;
  if (bit) {
    m.fast[i] += (65535 - m.fast[i]) >> rf;
    m.slow[i] += (65535 - m.slow[i]) >> rs;
  } else {
    m.fast[i] -= m.fast[i] >> rf;
    m.slow[i] -= m.slow[i] >> rs;
  }
}

/** bound = floor(range * p / 65536), computed exactly without overflow. */
function splitRange(range: number, p: number): number {
  return (range >>> 16) * p + (((range & 0xffff) * p) >>> 16);
}

export class RangeEncoder {
  private low = 0; // may temporarily exceed 2^32 (carry)
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out: Uint8Array;
  private pos = 0;

  constructor(capacityHint = 4096) {
    this.out = new Uint8Array(Math.max(64, capacityHint));
  }

  private writeByte(b: number): void {
    if (this.pos >= this.out.length) {
      const nb = new Uint8Array(this.out.length * 2);
      nb.set(this.out);
      this.out = nb;
    }
    this.out[this.pos++] = b;
  }

  private shiftLow(): void {
    const low = this.low;
    if (low >>> 0 < 0xff000000 || low >= 0x100000000) {
      const carry = low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.writeByte((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (low >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (low & 0x00ffffff) * 256;
  }

  /** Encode `bit` with adaptive context `m[i]`. */
  encode(m: Models, i: number, bit: number): void {
    const bound = splitRange(this.range, prob(m, i));
    if (bit) {
      this.range = bound;
    } else {
      this.low += bound;
      this.range -= bound;
    }
    update(m, i, bit);
    while (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  /** Encode `nbits` raw (equiprobable) bits, MSB first. */
  encodeDirect(value: number, nbits: number): void {
    for (let k = nbits - 1; k >= 0; k--) {
      const bit = Math.floor(value / 2 ** k) & 1;
      const bound = this.range >>> 1;
      if (bit) this.range = bound;
      else {
        this.low += bound;
        this.range -= bound;
      }
      while (this.range < TOP) {
        this.range = (this.range << 8) >>> 0;
        this.shiftLow();
      }
    }
  }

  /** Number of bytes produced so far (approximate until finish()). */
  get bytesSoFar(): number {
    return this.pos + this.cacheSize + 4;
  }

  finish(): Uint8Array {
    for (let k = 0; k < 5; k++) this.shiftLow();
    return this.out.slice(0, this.pos);
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;
  private overread = 0;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end = buf.length,
  ) {
    this.pos = start;
    for (let k = 0; k < 5; k++) this.code = ((this.code << 8) | this.nextByte()) >>> 0;
  }

  private nextByte(): number {
    if (this.pos < this.end) return this.buf[this.pos++];
    // Reading a few bytes past the end is normal at the tail of a stream
    // (the encoder flushes 4 bytes of state); much more means truncation.
    if (++this.overread > 8) fail(SmgErrorCode.TRUNCATED, 'entropy-coded stream ended unexpectedly');
    return 0;
  }

  decode(m: Models, i: number): number {
    const bound = splitRange(this.range, prob(m, i));
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      bit = 1;
    } else {
      this.code -= bound;
      this.range -= bound;
      bit = 0;
    }
    update(m, i, bit);
    while (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.nextByte()) >>> 0;
    }
    return bit;
  }

  decodeDirect(nbits: number): number {
    let v = 0;
    for (let k = 0; k < nbits; k++) {
      const bound = this.range >>> 1;
      let bit: number;
      if (this.code < bound) {
        this.range = bound;
        bit = 1;
      } else {
        this.code -= bound;
        this.range -= bound;
        bit = 0;
      }
      while (this.range < TOP) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.nextByte()) >>> 0;
      }
      v = v * 2 + bit;
    }
    return v;
  }

  /** Bytes consumed so far (including look-ahead). */
  get position(): number {
    return this.pos;
  }
}

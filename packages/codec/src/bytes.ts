import { fail, SmgErrorCode } from './errors.ts';

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this.pos;
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
    return this;
  }

  f32(v: number): this {
    const tmp = new DataView(new ArrayBuffer(4));
    tmp.setFloat32(0, v, true);
    return this.bytes(new Uint8Array(tmp.buffer));
  }

  /** Unsigned LEB128 varint (up to 2^53). */
  varint(v: number): this {
    if (v < 0 || !Number.isInteger(v)) fail(SmgErrorCode.INVALID_ARGUMENT, `varint must be a non-negative integer, got ${v}`);
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
    return this;
  }

  /** Zig-zag signed varint. */
  svarint(v: number): this {
    return this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** Length-prefixed UTF-8 string. */
  string(s: string): this {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    return this.bytes(b);
  }

  /** Length-prefixed byte block. */
  block(b: Uint8Array): this {
    this.varint(b.length);
    return this.bytes(b);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Bounds-checked little-endian byte reader. Throws SMG_E_TRUNCATED on overrun. */
export class ByteReader {
  pos: number;
  readonly end: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
    private readonly what = 'data',
  ) {
    this.pos = start;
    this.end = end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) fail(SmgErrorCode.TRUNCATED, `unexpected end of ${this.what} (needed ${n} more bytes at offset ${this.pos})`);
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const b = this.buf;
    const p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }

  f32(): number {
    this.need(4);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return dv.getFloat32(0, true);
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 0x80;
    }
    return fail(SmgErrorCode.CORRUPT_PAYLOAD, `varint too long in ${this.what}`);
  }

  svarint(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  string(maxLen = 1 << 20): string {
    const n = this.varint();
    if (n > maxLen) fail(SmgErrorCode.CORRUPT_PAYLOAD, `string length ${n} exceeds limit in ${this.what}`);
    return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes(n));
  }

  block(maxLen = 1 << 30): Uint8Array {
    const n = this.varint();
    if (n > maxLen) fail(SmgErrorCode.CORRUPT_PAYLOAD, `block length ${n} exceeds limit in ${this.what}`);
    return this.bytes(n);
  }
}

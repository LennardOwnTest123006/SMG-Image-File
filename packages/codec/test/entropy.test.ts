import { describe, expect, it } from 'vitest';
import { Models, RangeDecoder, RangeEncoder } from '../src/entropy/rangecoder.ts';
import { IntContexts, TreeContexts } from '../src/entropy/intcoder.ts';
import { rng } from './helpers.ts';

describe('range coder', () => {
  it('round-trips adaptive bits with skewed and uniform statistics', () => {
    const r = rng(42);
    const bits: Array<[number, number]> = [];
    for (let i = 0; i < 200_000; i++) {
      const ctx = i % 7;
      const p = [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.9999][ctx];
      bits.push([ctx, r() < p ? 1 : 0]);
    }
    const em = new Models(7);
    const enc = new RangeEncoder();
    for (const [c, b] of bits) enc.encode(em, c, b);
    const buf = enc.finish();
    const dm = new Models(7);
    const dec = new RangeDecoder(buf);
    for (const [c, b] of bits) expect(dec.decode(dm, c)).toBe(b);
    // Skewed contexts must compress well below 1 bit/symbol on average.
    expect(buf.length * 8).toBeLessThan(bits.length * 0.5);
  });

  it('round-trips direct (equiprobable) bits including carries', () => {
    const r = rng(7);
    const vals = Array.from({ length: 5000 }, () => Math.floor(r() * 2 ** 31));
    const enc = new RangeEncoder();
    const m = new Models(1);
    vals.forEach((v, i) => {
      enc.encodeDirect(v, 31);
      enc.encode(m, 0, i & 1);
    });
    const dec = new RangeDecoder(enc.finish());
    const m2 = new Models(1);
    vals.forEach((v, i) => {
      expect(dec.decodeDirect(31)).toBe(v);
      expect(dec.decode(m2, 0)).toBe(i & 1);
    });
  });

  it('reports truncation instead of looping forever', () => {
    const enc = new RangeEncoder();
    const m = new Models(1);
    for (let i = 0; i < 10_000; i++) enc.encodeDirect(i & 255, 8);
    const buf = enc.finish().subarray(0, 100);
    const dec = new RangeDecoder(buf);
    expect(() => {
      for (let i = 0; i < 10_000; i++) dec.decodeDirect(8);
    }).toThrow(/SMG_E_TRUNCATED/);
    void m;
  });
});

describe('integer coder', () => {
  it('round-trips signed integers across the full range', () => {
    const r = rng(3);
    const ints = new IntContexts(4, 20, 9);
    const values: Array<[number, number, number]> = [];
    for (let i = 0; i < 50_000; i++) {
      const mag = Math.floor(2 ** (r() * 19));
      const v = r() < 0.3 ? 0 : r() < 0.5 ? -mag : mag;
      values.push([i % 4, v, i % 9]);
    }
    values.push([0, ints.maxAbs, 0], [1, -ints.maxAbs, 8]);
    const enc = new RangeEncoder();
    for (const [s, v, sc] of values) ints.encode(enc, s, v, sc);
    const dec = new RangeDecoder(enc.finish());
    const ints2 = new IntContexts(4, 20, 9);
    for (const [s, v, sc] of values) expect(ints2.decode(dec, s, sc)).toBe(v);
  });

  it('rejects out-of-range values', () => {
    const ints = new IntContexts(1, 4);
    expect(() => ints.encode(new RangeEncoder(), 0, 16)).toThrow(/SMG_E_ARGUMENT/);
  });

  it('round-trips tree-coded symbols', () => {
    const t = new TreeContexts(3, 8);
    const enc = new RangeEncoder();
    const vals = Array.from({ length: 3000 }, (_, i) => (i * 37) & 255);
    vals.forEach((v, i) => t.encode(enc, i % 3, v));
    const dec = new RangeDecoder(enc.finish());
    const t2 = new TreeContexts(3, 8);
    vals.forEach((v, i) => expect(t2.decode(dec, i % 3)).toBe(v));
  });
});

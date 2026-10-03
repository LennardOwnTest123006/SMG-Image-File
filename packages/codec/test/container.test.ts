import { describe, expect, it } from 'vitest';
import { decode, encode, inspect, isSmg, isSmgError, SmgErrorCode, SIGNATURE, crc32, pixelsEqual } from '../src/index.ts';
import { makeImage, rng } from './helpers.ts';

function sample() {
  const img = makeImage(24, 18, 'graphic', 1);
  return { img, bytes: encode(img, { mode: 'lossless' }).bytes };
}

/** Recompute the CRC of the chunk that starts at `off` after a payload edit. */
function fixCrc(bytes: Uint8Array, off: number): void {
  let p = off + 4;
  let len = 0, mul = 1;
  for (;;) {
    const b = bytes[p++];
    len += (b & 0x7f) * mul;
    if (!(b & 0x80)) break;
    mul *= 128;
  }
  const end = p + len;
  const c = crc32(bytes, off, end);
  bytes[end] = c & 255; bytes[end + 1] = (c >>> 8) & 255; bytes[end + 2] = (c >>> 16) & 255; bytes[end + 3] = (c >>> 24) & 255;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isSmgError(e)) return e.code;
    throw e;
  }
  return 'OK';
}

describe('container', () => {
  it('starts with the SMG signature and version 1.0', () => {
    const { bytes } = sample();
    expect([...bytes.subarray(0, 8)]).toEqual([...SIGNATURE]);
    expect(bytes[8]).toBe(1);
    expect(bytes[9]).toBe(0);
    expect(isSmg(bytes)).toBe(true);
    expect(isSmg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it('lists chunks in order HEAD … DATA TAIL', () => {
    const { bytes } = sample();
    const tags = inspect(bytes).chunks.map((c) => c.tag);
    expect(tags[0]).toBe('HEAD');
    expect(tags.at(-2)).toBe('DATA');
    expect(tags.at(-1)).toBe('TAIL');
  });

  it('rejects files with a bad signature', () => {
    expect(codeOf(() => decode(new Uint8Array(64)))).toBe(SmgErrorCode.BAD_SIGNATURE);
    expect(codeOf(() => decode(new TextEncoder().encode('hello world, not an image')))).toBe(SmgErrorCode.BAD_SIGNATURE);
  });

  it('rejects unsupported major versions but accepts newer minor versions', () => {
    const { bytes } = sample();
    const v2 = bytes.slice();
    v2[8] = 2;
    expect(codeOf(() => decode(v2))).toBe(SmgErrorCode.UNSUPPORTED_VERSION);
    const v1_9 = bytes.slice();
    v1_9[9] = 9;
    expect(codeOf(() => decode(v1_9))).toBe('OK');
  });

  it('detects truncation at every possible length', () => {
    const { bytes } = sample();
    for (let n = 0; n < bytes.length; n++) {
      const code = codeOf(() => decode(bytes.subarray(0, n)));
      expect([SmgErrorCode.TRUNCATED, SmgErrorCode.BAD_SIGNATURE, SmgErrorCode.CRC_MISMATCH]).toContain(code);
    }
  });

  it('detects single-byte corruption via CRC', () => {
    const { bytes } = sample();
    for (let i = 10; i < bytes.length; i += 3) {
      const b = bytes.slice();
      b[i] ^= 0x40;
      expect(codeOf(() => decode(b))).not.toBe('OK');
    }
  });

  it('rejects unknown critical chunks and skips unknown ancillary chunks', () => {
    const { img, bytes } = sample();
    const insert = (tag: string) => {
      const tb = new TextEncoder().encode(tag);
      const chunk = new Uint8Array(4 + 1 + 3 + 4);
      chunk.set(tb);
      chunk[4] = 3;
      chunk.set([1, 2, 3], 5);
      const c = crc32(chunk, 0, 8);
      chunk.set([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24], 8);
      const headEnd = inspect(bytes).chunks[1].offset;
      const out = new Uint8Array(bytes.length + chunk.length);
      out.set(bytes.subarray(0, headEnd));
      out.set(chunk, headEnd);
      out.set(bytes.subarray(headEnd), headEnd + chunk.length);
      return out;
    };
    expect(codeOf(() => decode(insert('ZZZZ')))).toBe(SmgErrorCode.UNKNOWN_CRITICAL_CHUNK);
    const withAnc = insert('zfut');
    expect(pixelsEqual(decode(withAnc).image, img)).toBe(true);
    expect(inspect(withAnc).chunks.map((c) => c.tag)).toContain('zfut');
  });

  it('enforces chunk order rules', () => {
    const { bytes } = sample();
    // Swap the HEAD tag for an ancillary tag: first chunk is no longer HEAD.
    const b = bytes.slice();
    b.set(new TextEncoder().encode('hEAD'), 10);
    fixCrc(b, 10);
    expect(codeOf(() => decode(b))).toBe(SmgErrorCode.CHUNK_ORDER);
    // Data after TAIL
    const extra = new Uint8Array(bytes.length + 3);
    extra.set(bytes);
    expect(codeOf(() => decode(extra))).not.toBe('OK');
  });

  it('enforces decode limits', () => {
    const img = makeImage(300, 200, 'flat');
    const { bytes } = encode(img, { mode: 'lossless' });
    expect(codeOf(() => decode(bytes, { maxPixels: 50_000 }))).toBe(SmgErrorCode.LIMIT_EXCEEDED);
    expect(codeOf(() => decode(bytes, { maxDimension: 256 }))).toBe(SmgErrorCode.LIMIT_EXCEEDED);
    expect(codeOf(() => decode(bytes))).toBe('OK');
  });

  it('validates header fields', () => {
    const { bytes } = sample();
    const info = inspect(bytes);
    const headPayload = info.chunks[0].offset + 4 + 1; // tag + 1-byte varint length
    // colour model byte follows two 1-byte varints (24, 18)
    const b = bytes.slice();
    b[headPayload + 2] = 9;
    fixCrc(b, 10);
    expect(codeOf(() => decode(b))).toBe(SmgErrorCode.BAD_HEADER);
    const c = bytes.slice();
    c[headPayload + 3] = 16; // bit depth
    fixCrc(c, 10);
    expect(codeOf(() => decode(c))).toBe(SmgErrorCode.BAD_HEADER);
    const d = bytes.slice();
    d[headPayload + 4] = 77; // codec id
    fixCrc(d, 10);
    expect(codeOf(() => decode(d))).toBe(SmgErrorCode.UNSUPPORTED_CODEC);
  });

  it('survives fuzzed payloads (valid CRC) without crashing or hanging', () => {
    const r = rng(99);
    const sources = [
      encode(makeImage(40, 30, 'smooth', 1), { mode: 'lossless' }).bytes,
      encode(makeImage(40, 30, 'text', 2), { mode: 'lossless', effort: 9 }).bytes,
      encode(makeImage(40, 30, 'graphic', 3), { mode: 'palette' }).bytes,
      encode(makeImage(40, 30, 'smooth', 4), { mode: 'lossy', quality: 70 }).bytes,
      encode(makeImage(40, 30, 'alpha', 5), { mode: 'lossy', quality: 70, effort: 1 }).bytes,
    ];
    let errors = 0, ok = 0;
    for (const src of sources) {
      const dataChunk = inspect(src).chunks.find((c) => c.tag === 'DATA')!;
      for (let iter = 0; iter < 150; iter++) {
        const b = src.slice();
        const flips = 1 + Math.floor(r() * 4);
        for (let f = 0; f < flips; f++) {
          const at = dataChunk.offset + 6 + Math.floor(r() * (dataChunk.length - 2));
          b[at] ^= 1 << Math.floor(r() * 8);
        }
        fixCrc(b, dataChunk.offset);
        const code = codeOf(() => decode(b, { verifyChecksum: true }));
        if (code === 'OK') ok++;
        else errors++;
      }
    }
    // Every outcome is either a clean decode (lossy streams can absorb noise) or an SmgError.
    expect(errors + ok).toBe(5 * 150);
    expect(errors).toBeGreaterThan(0);
  });
});

describe('metadata', () => {
  it('round-trips text, ICC, EXIF and XMP', () => {
    const img = makeImage(20, 20, 'smooth');
    const icc = new Uint8Array(512).map((_, i) => (i * 7) & 255);
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]);
    const text = { Title: 'Sunset ☀', Author: 'SMG Tests', Copyright: 'CC0', Software: 'SMG 1.0' };
    const r = encode(img, { mode: 'lossy', metadata: { text, icc, exif, xmp: '<x:xmpmeta/>' } });
    const info = decode(r.bytes).info;
    expect(info.metadata.text).toEqual(text);
    expect([...info.metadata.icc!]).toEqual([...icc]);
    expect([...info.metadata.exif!]).toEqual([...exif]);
    expect(info.metadata.xmp).toBe('<x:xmpmeta/>');
    expect(r.info.metadataBytes).toBeGreaterThan(icc.length);
  });

  it('strips metadata on request', () => {
    const img = makeImage(20, 20, 'smooth');
    const md = { text: { Title: 'x' }, icc: new Uint8Array(100) };
    const kept = encode(img, { mode: 'lossless', metadata: md });
    const stripped = encode(img, { mode: 'lossless', metadata: md, stripMetadata: true });
    expect(stripped.bytes.length).toBeLessThan(kept.bytes.length);
    expect(inspect(stripped.bytes).metadata).toEqual({});
  });

  it('detects pixel checksum mismatches', () => {
    const img = makeImage(20, 20, 'graphic');
    const r = encode(img, { mode: 'lossless' });
    const info = inspect(r.bytes);
    const cs = info.chunks.find((c) => c.tag === 'csum')!;
    const b = r.bytes.slice();
    b[cs.offset + 6] ^= 1;
    fixCrc(b, cs.offset);
    expect(codeOf(() => decode(b))).toBe(SmgErrorCode.CHECKSUM_MISMATCH);
    expect(codeOf(() => decode(b, { verifyChecksum: false }))).toBe('OK');
  });
});

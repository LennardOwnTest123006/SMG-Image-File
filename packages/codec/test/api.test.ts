import { describe, expect, it } from 'vitest';
import {
  analyzeImage, compressionStats, decode, describeStats, encode, formatBytes, inspect, pixelHash, pixelsEqual,
  PRESETS, SmgErrorCode, isSmgError, CodecId, countDifferentPixels, type SmgPreset,
} from '../src/index.ts';
import { makeImage } from './helpers.ts';

describe('encoder API', () => {
  it('supports every preset and reports consistent info', () => {
    const img = makeImage(64, 48, 'smooth', 3);
    for (const preset of Object.keys(PRESETS) as SmgPreset[]) {
      const r = encode(img, { preset });
      expect(r.info.preset).toBe(preset);
      expect(r.info.outputBytes).toBe(r.bytes.length);
      expect(r.info.rawBytes).toBe(64 * 48 * 4);
      expect(r.info.candidates.filter((c) => c.chosen)).toHaveLength(1);
      const d = decode(r.bytes);
      expect(d.info.codec).toBe(r.info.codec);
      // The exact flag must be truthful.
      expect(pixelsEqual(d.image, img)).toBe(r.info.exact);
    }
  });

  it('auto mode picks lossless/palette for graphics and wavelet for photos', () => {
    const graphic = encode(makeImage(80, 60, 'flat'), { mode: 'auto' });
    expect([CodecId.PALETTE, CodecId.LOSSLESS]).toContain(graphic.info.codec);
    expect(graphic.info.exact).toBe(true);
    const photo = encode(makeImage(120, 90, 'smooth'), { mode: 'auto' });
    expect(photo.info.analysis.kind).toBe('photo');
    expect(photo.info.codec).toBe(CodecId.WAVELET);
  });

  it('compares candidates and picks the smallest acceptable one', () => {
    const img = makeImage(100, 80, 'graphic', 2);
    const r = encode(img, { mode: 'lossless', effort: 9 });
    expect(r.info.candidates.length).toBeGreaterThan(2);
    const chosen = r.info.candidates.find((c) => c.chosen)!;
    for (const c of r.info.candidates) expect(chosen.bytes).toBeLessThanOrEqual(c.bytes);
  });

  it('reports progress and can be cancelled', () => {
    const img = makeImage(64, 64, 'smooth');
    const seen: number[] = [];
    encode(img, { onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    let err: unknown;
    try {
      encode(img, { signal: { aborted: true } });
    } catch (e) {
      err = e;
    }
    expect(isSmgError(err) && err.code).toBe(SmgErrorCode.ABORTED);
  });

  it('validates arguments', () => {
    const codeOf = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return isSmgError(e) ? e.code : 'other'; } };
    expect(codeOf(() => encode({ width: 2, height: 2, data: new Uint8Array(3) }))).toBe(SmgErrorCode.INVALID_ARGUMENT);
    expect(codeOf(() => encode({ width: 0, height: 2, data: new Uint8Array(0) }))).toBe(SmgErrorCode.INVALID_ARGUMENT);
    expect(codeOf(() => encode(makeImage(4, 4, 'flat'), { preset: 'nope' as SmgPreset }))).toBe(SmgErrorCode.INVALID_ARGUMENT);
    expect(codeOf(() => encode(makeImage(4, 4, 'flat'), { quality: Number.NaN }))).toBe(SmgErrorCode.INVALID_ARGUMENT);
  });

  it('accepts Uint8ClampedArray input (canvas ImageData)', () => {
    const img = makeImage(10, 10, 'graphic');
    const r = encode({ width: 10, height: 10, data: new Uint8ClampedArray(img.data) }, { mode: 'lossless' });
    expect(pixelsEqual(decode(r.bytes).image, img)).toBe(true);
  });
});

describe('statistics', () => {
  it('computes real compression statistics', () => {
    const s = compressionStats(1_200_000, 180_000, 1000 * 800);
    expect(s.savedBytes).toBe(1_020_000);
    expect(s.reductionPercent).toBeCloseTo(85, 5);
    expect(s.ratio).toBeCloseTo(6.6667, 3);
    expect(s.bitsPerPixel).toBeCloseTo(1.8, 5);
    expect(describeStats(s)).toBe('Original: 1.2 MB · SMG: 180 KB · Space saved: 85%');
    const worse = compressionStats(1000, 1500);
    expect(worse.reductionPercent).toBe(-50);
    expect(describeStats(worse)).toContain('Larger by 50.0%');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(180_000)).toBe('180 KB');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
  });

  it('stats match the actual encoded size', () => {
    const img = makeImage(50, 50, 'smooth');
    const r = encode(img, { mode: 'lossy', quality: 60 });
    const s = compressionStats(img.data.length, r.bytes.length, 2500);
    expect(s.compressedBytes).toBe(inspect(r.bytes).fileBytes);
  });
});

describe('batch & duplicates', () => {
  it('encodes a batch and identifies duplicate images by pixel hash', () => {
    const a = makeImage(30, 20, 'graphic', 1);
    const b = makeImage(30, 20, 'graphic', 1);
    const c = makeImage(30, 20, 'smooth', 2);
    const batch = [a, b, c];
    const hashes = batch.map(pixelHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
    const results = batch.map((img) => encode(img, { preset: 'auto' }));
    results.forEach((r, i) => {
      const d = decode(r.bytes).image;
      if (r.info.exact) expect(pixelsEqual(d, batch[i])).toBe(true);
      else expect(countDifferentPixels(d, batch[i])).toBeGreaterThan(0);
    });
    // Same input → identical output bytes (deterministic encoder).
    expect([...results[0].bytes]).toEqual([...results[1].bytes]);
  });

  it('analysis classifies content', () => {
    expect(analyzeImage(makeImage(64, 64, 'smooth')).kind).toBe('photo');
    expect(analyzeImage(makeImage(64, 64, 'flat')).kind).not.toBe('photo');
    const a = analyzeImage(makeImage(32, 32, 'binaryAlpha'));
    expect(a.hasAlpha).toBe(true);
    expect(a.binaryAlpha).toBe(true);
    expect(analyzeImage(makeImage(16, 16, 'gray')).grayscale).toBe(true);
  });
});

describe('large images', () => {
  it('round-trips a 2048×1536 image losslessly and lossily', () => {
    const img = makeImage(2048, 1536, 'smooth', 77);
    const ll = encode(img, { mode: 'lossless', effort: 2 });
    expect(pixelsEqual(decode(ll.bytes).image, img)).toBe(true);
    const ly = encode(img, { mode: 'lossy', quality: 75 });
    expect(ly.bytes.length).toBeLessThan(ll.bytes.length / 3);
    expect(decode(ly.bytes).image.width).toBe(2048);
  });
});

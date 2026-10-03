import { describe, expect, it } from 'vitest';
import { decode, encode, inspect, pixelsEqual, psnr, ColorModel, CodecId, HeadFlags, ssim } from '../src/index.ts';
import { encodeLossless, decodeLossless, Transform } from '../src/codecs/lossless.ts';
import { buildPalette } from '../src/codecs/palette.ts';
import { makeImage, type Kind } from './helpers.ts';

const SIZES: Array<[number, number]> = [[1, 1], [1, 9], [9, 1], [2, 2], [3, 5], [17, 13], [33, 32], [64, 48], [129, 67]];
const KINDS: Kind[] = ['noise', 'smooth', 'flat', 'graphic', 'gray', 'alpha', 'binaryAlpha', 'text'];

describe('SMG-L lossless', () => {
  for (const [w, h] of SIZES) {
    for (const kind of KINDS) {
      it(`is bit-exact for ${kind} ${w}×${h}`, () => {
        const img = makeImage(w, h, kind, w * 31 + h);
        const r = encode(img, { mode: 'lossless' });
        expect(r.info.exact).toBe(true);
        const d = decode(r.bytes);
        expect(pixelsEqual(img, d.image)).toBe(true);
        expect(d.info.exact).toBe(true);
        expect(d.info.checksum).not.toBeNull();
      });
    }
  }

  it('round-trips every colour transform with and without LZ for every colour model', () => {
    const base = makeImage(40, 30, 'text', 5);
    const variants: Array<[number, (d: Uint8Array) => void]> = [
      [ColorModel.RGBA, (d) => { for (let i = 3; i < d.length; i += 16) d[i] = 77; }],
      [ColorModel.RGB, () => {}],
      [ColorModel.GRAY, (d) => { for (let i = 0; i < d.length; i += 4) d[i + 1] = d[i + 2] = d[i]; }],
      [ColorModel.GRAY_ALPHA, (d) => { for (let i = 0; i < d.length; i += 4) { d[i + 1] = d[i + 2] = d[i]; d[i + 3] = (i * 3) & 255; } }],
    ];
    for (const [model, mut] of variants) {
      const img = { ...base, data: new Uint8Array(base.data) };
      mut(img.data);
      for (const t of [Transform.NONE, Transform.YCOCG, Transform.SUBGREEN]) {
        for (const lz of [false, true]) {
          const payload = encodeLossless(img, model, t, { lz });
          const out = decodeLossless(payload, img.width, img.height, model);
          expect(pixelsEqual(img, { ...img, data: out })).toBe(true);
        }
      }
    }
  });

  it('compresses smooth content well below raw size', () => {
    const img = makeImage(256, 256, 'smooth', 9);
    const r = encode(img, { mode: 'lossless' });
    expect(r.bytes.length).toBeLessThan(img.data.length * 0.5);
  });

  it('LZ mode shrinks repetitive graphics', () => {
    const img = makeImage(200, 120, 'text', 4);
    const plain = encodeLossless(img, ColorModel.RGB, Transform.SUBGREEN, { lz: false });
    const lz = encodeLossless(img, ColorModel.RGB, Transform.SUBGREEN, { lz: true, chain: 64 });
    expect(lz.length).toBeLessThan(plain.length);
  });
});

describe('SMG-P palette', () => {
  it('is exact for images with ≤256 colours', () => {
    for (const kind of ['flat', 'graphic'] as Kind[]) {
      const img = makeImage(70, 50, kind, 3);
      const r = encode(img, { mode: 'palette' });
      expect(r.info.codec).toBe(CodecId.PALETTE);
      expect(r.info.exact).toBe(true);
      expect(pixelsEqual(decode(r.bytes).image, img)).toBe(true);
    }
  });

  it('normalises invisible colours only when allowed (visually lossless)', () => {
    // Random junk RGB under alpha = 0 gives > 256 colours.
    const img = makeImage(70, 50, 'binaryAlpha', 3);
    const exact = encode(img, { mode: 'lossless' });
    expect(exact.info.exact).toBe(true);
    expect(pixelsEqual(decode(exact.bytes).image, img)).toBe(true);
    const r = encode(img, { mode: 'lossless', exactTransparent: false });
    expect(r.info.exact).toBe(false);
    expect(r.info.visuallyLossless).toBe(true);
    expect(r.bytes.length).toBeLessThan(exact.bytes.length);
    const d = decode(r.bytes);
    expect(d.info.visuallyLossless).toBe(true);
    for (let p = 0; p < img.data.length; p += 4) {
      expect(d.image.data[p + 3]).toBe(img.data[p + 3]);
      if (img.data[p + 3] !== 0) for (let c = 0; c < 3; c++) expect(d.image.data[p + c]).toBe(img.data[p + c]);
    }
    expect(psnr(img, d.image)).toBe(Infinity);
  });

  it('handles single-colour and 256-colour images', () => {
    const one = makeImage(16, 16, 'flat');
    one.data.fill(200);
    const r1 = encode(one, { mode: 'palette' });
    expect(pixelsEqual(decode(r1.bytes).image, one)).toBe(true);
    const many = makeImage(16, 16, 'flat');
    for (let i = 0; i < 256; i++) { many.data[i * 4] = i; many.data[i * 4 + 1] = 255 - i; many.data[i * 4 + 2] = i ^ 0x55; many.data[i * 4 + 3] = 255; }
    expect(buildPalette(many)!.palette.length).toBe(256);
    const r2 = encode(many, { mode: 'palette' });
    expect(r2.info.exact).toBe(true);
    expect(pixelsEqual(decode(r2.bytes).image, many)).toBe(true);
  });

  it('quantises images with more colours and reports them as not exact', () => {
    const img = makeImage(96, 64, 'smooth', 2);
    expect(buildPalette(img)).toBeNull();
    for (const dither of [false, true]) {
      const r = encode(img, { mode: 'palette', maxColors: 32, dither });
      expect(r.info.exact).toBe(false);
      const d = decode(r.bytes);
      expect(d.info.quantized).toBe(true);
      expect(d.info.flags & HeadFlags.EXACT).toBe(0);
      const colours = new Set<number>();
      for (let i = 0; i < d.image.data.length; i += 4) colours.add((d.image.data[i] << 16) | (d.image.data[i + 1] << 8) | d.image.data[i + 2]);
      expect(colours.size).toBeLessThanOrEqual(32);
      expect(psnr(img, d.image)).toBeGreaterThan(22);
    }
  });
});

describe('SMG-W wavelet lossy', () => {
  for (const [w, h] of SIZES) {
    it(`decodes ${w}×${h} images with plausible quality`, () => {
      const img = makeImage(w, h, 'smooth', w + h);
      const r = encode(img, { mode: 'lossy', quality: 90 });
      const d = decode(r.bytes);
      expect(d.image.width).toBe(w);
      expect(d.image.height).toBe(h);
      if (r.info.codec === CodecId.WAVELET) {
        expect(r.info.exact).toBe(false);
        expect(psnr(img, d.image)).toBeGreaterThan(30);
      }
    });
  }

  it('produces smaller files at lower quality (monotonic size)', () => {
    const img = makeImage(160, 120, 'smooth', 11);
    const sizes = [95, 85, 70, 50, 30, 10].map((q) => encode(img, { mode: 'lossy', quality: q }).bytes.length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
  });

  it('quality tracks the quality setting', () => {
    const img = makeImage(128, 128, 'smooth', 12);
    const hi = decode(encode(img, { mode: 'lossy', quality: 92 }).bytes).image;
    const lo = decode(encode(img, { mode: 'lossy', quality: 20 }).bytes).image;
    expect(psnr(img, hi)).toBeGreaterThan(psnr(img, lo));
    expect(ssim(img, hi)).toBeGreaterThan(0.95);
  });

  it('keeps alpha exact while compressing colour lossily', () => {
    const img = makeImage(90, 70, 'alpha', 5);
    const r = encode(img, { mode: 'lossy', quality: 75, effort: 1 });
    expect(r.info.codec).toBe(CodecId.WAVELET);
    expect(r.info.colorModel).toBe(ColorModel.RGBA);
    const d = decode(r.bytes);
    for (let i = 3; i < img.data.length; i += 4) expect(d.image.data[i]).toBe(img.data[i]);
  });

  it('encodes grayscale as a single channel', () => {
    const img = makeImage(80, 60, 'gray', 2);
    const r = encode(img, { mode: 'lossy', quality: 80, effort: 1 });
    expect(r.info.colorModel).toBe(ColorModel.GRAY);
    const d = decode(r.bytes);
    for (let i = 0; i < d.image.data.length; i += 4) {
      expect(d.image.data[i]).toBe(d.image.data[i + 1]);
      expect(d.image.data[i]).toBe(d.image.data[i + 2]);
    }
  });

  it('hits a target file size', () => {
    const img = makeImage(200, 150, 'smooth', 21);
    for (const target of [1500, 4000, 12000]) {
      const r = encode(img, { mode: 'lossy', targetSize: target });
      expect(r.info.targetMet).toBe(true);
      expect(r.bytes.length).toBeLessThanOrEqual(target);
      expect(inspect(r.bytes).quality).not.toBeNull();
    }
  });

  it('reports an unmet target honestly', () => {
    const img = makeImage(300, 300, 'noise', 1);
    const r = encode(img, { mode: 'lossy', targetSize: 200 });
    expect(r.info.targetMet).toBe(false);
    expect(r.bytes.length).toBeGreaterThan(200);
  });
});

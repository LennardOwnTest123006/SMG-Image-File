import { describe, expect, it } from 'vitest';
import { decodeBmp, decodeGif, decodePng, detectFormat, encodeBmp, encodePng, createZip, exifOrientation, applyOrientation, resizeImage, cropImage, rotateImage90, flipImage, readJpegMetadata } from '../src/io/index.ts';
import { decode, encode, pixelsEqual, isSmgError, SmgErrorCode, crc32 } from '../src/index.ts';
import { makeImage } from './helpers.ts';

describe('PNG', () => {
  for (const kind of ['smooth', 'alpha', 'gray', 'flat'] as const) {
    it(`encodes and decodes ${kind} images exactly`, () => {
      const img = makeImage(37, 23, kind, 4);
      const png = encodePng(img, { text: { Software: 'SMG' } });
      expect(detectFormat(png)).toBe('png');
      const back = decodePng(png);
      expect(pixelsEqual(back.image, img)).toBe(true);
      expect(back.text.Software).toBe('SMG');
    });
  }

  it('preserves ICC profiles', () => {
    const icc = new Uint8Array(300).map((_, i) => i & 255);
    const back = decodePng(encodePng(makeImage(4, 4, 'flat'), { icc }));
    expect([...back.icc!]).toEqual([...icc]);
  });

  it('rejects corrupt PNGs with SMG_E_INPUT', () => {
    const png = encodePng(makeImage(8, 8, 'smooth'));
    png[40] ^= 0xff;
    try {
      decodePng(png);
      expect.unreachable();
    } catch (e) {
      expect(isSmgError(e) && e.code).toBe(SmgErrorCode.BAD_INPUT_IMAGE);
    }
  });

  it('PNG → SMG → PNG workflow is bit-exact', () => {
    const img = makeImage(50, 40, 'alpha', 8);
    const smg = encode(decodePng(encodePng(img)).image, { mode: 'lossless' });
    const png2 = encodePng(decode(smg.bytes).image);
    expect(pixelsEqual(decodePng(png2).image, img)).toBe(true);
  });
});

describe('BMP', () => {
  it('round-trips 24-bit and 32-bit bitmaps', () => {
    for (const kind of ['smooth', 'alpha'] as const) {
      const img = makeImage(13, 7, kind, 1);
      const bmp = encodeBmp(img);
      expect(detectFormat(bmp)).toBe('bmp');
      expect(pixelsEqual(decodeBmp(bmp), img)).toBe(true);
    }
  });

  it('decodes an 8-bit RLE8 bitmap', () => {
    // 4×2 image, palette [red, blue], RLE8 data: run(4,red) EOL run(2,blue) run(1,red) run(1,blue) EOB
    const header = new Uint8Array(54 + 8);
    const dv = new DataView(header.buffer);
    header[0] = 0x42; header[1] = 0x4d;
    dv.setUint32(10, 54 + 8, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, 4, true);
    dv.setInt32(22, 2, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 8, true);
    dv.setUint32(30, 1, true);
    dv.setUint32(46, 2, true);
    header.set([0, 0, 255, 0, 255, 0, 0, 0], 54); // BGRA: red, blue
    const rle = new Uint8Array([4, 0, 0, 0, 2, 1, 1, 0, 1, 1, 0, 1]);
    const file = new Uint8Array(header.length + rle.length);
    file.set(header);
    file.set(rle, header.length);
    const img = decodeBmp(file);
    // bottom row (y=1) all red; top row blue blue red blue
    expect([...img.data.subarray(16, 20)]).toEqual([255, 0, 0, 255]);
    expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...img.data.subarray(8, 12)]).toEqual([255, 0, 0, 255]);
  });
});

describe('GIF', () => {
  /** Build a tiny 2-frame GIF by hand (uncompressed-style LZW with clear codes). */
  function makeGif(): Uint8Array {
    const bytes: number[] = [];
    const push = (...b: number[]) => bytes.push(...b);
    push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
    push(2, 0, 2, 0, 0x80 | 0x00, 0, 0); // 2×2, GCT with 2 entries
    push(255, 0, 0, 0, 0, 255); // red, blue
    push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    const frame = (indices: number[], transparent: number | null, disposal: number) => {
      push(0x21, 0xf9, 4, (disposal << 2) | (transparent !== null ? 1 : 0), 10, 0, transparent ?? 0, 0);
      push(0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0);
      push(2); // min code size
      // codes (3 bits): clear(4), each index followed by clear to keep code size at 3, eoi(5)
      const codes: number[] = [4];
      for (const ix of indices) codes.push(ix, 4);
      codes.push(5);
      let acc = 0, nbits = 0;
      const data: number[] = [];
      for (const c of codes) {
        acc |= c << nbits;
        nbits += 3;
        while (nbits >= 8) { data.push(acc & 255); acc >>= 8; nbits -= 8; }
      }
      if (nbits > 0) data.push(acc & 255);
      push(data.length, ...data, 0);
    };
    frame([0, 1, 1, 0], null, 1);
    frame([1, 1, 1, 1], 1, 0); // fully transparent frame: previous content stays
    push(0x3b);
    return new Uint8Array(bytes);
  }

  it('decodes frames, delays, loop count and transparency', () => {
    const g = decodeGif(makeGif());
    expect(g.width).toBe(2);
    expect(g.frames).toHaveLength(2);
    expect(g.loopCount).toBe(0);
    expect(g.frames[0].delayMs).toBe(100);
    const f0 = g.frames[0].image.data;
    expect([...f0.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...f0.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
    expect([...g.frames[1].image.data]).toEqual([...f0]);
  });

  it('converts GIF frames to SMG', () => {
    const g = decodeGif(makeGif());
    for (const f of g.frames) {
      const r = encode(f.image, { mode: 'lossless' });
      expect(pixelsEqual(decode(r.bytes).image, f.image)).toBe(true);
    }
  });
});

describe('format detection & helpers', () => {
  it('sniffs common formats', () => {
    expect(detectFormat(encode(makeImage(2, 2, 'flat')).bytes)).toBe('smg');
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectFormat(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(detectFormat(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    expect(detectFormat(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('avif');
    expect(detectFormat(new Uint8Array([1, 2, 3]))).toBe('unknown');
  });

  it('writes valid ZIP archives', () => {
    const zip = createZip([{ name: 'a.smg', data: new Uint8Array([1, 2, 3]) }, { name: 'a.smg', data: new Uint8Array([4]) }]);
    expect(zip[0]).toBe(0x50);
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('a.smg');
    expect(text).toContain('a (2).smg');
    // CRC of first entry stored at offset 14
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(14, true)).toBe(crc32(new Uint8Array([1, 2, 3])));
  });

  it('applies EXIF orientation and geometric transforms', () => {
    const img = makeImage(5, 3, 'smooth');
    const r = rotateImage90(img, 1);
    expect([r.width, r.height]).toEqual([3, 5]);
    expect(pixelsEqual(rotateImage90(r, 3), img)).toBe(true);
    expect(pixelsEqual(flipImage(flipImage(img, true), true), img)).toBe(true);
    expect(pixelsEqual(applyOrientation(img, 1), img)).toBe(true);
    expect(applyOrientation(img, 6).width).toBe(3);
    const c = cropImage(img, 1, 1, 3, 2);
    expect([c.width, c.height]).toEqual([3, 2]);
    const s = resizeImage(makeImage(64, 64, 'flat'), 16, 16);
    expect([s.width, s.height]).toEqual([16, 16]);
    // EXIF with orientation 6 (little endian)
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    expect(exifOrientation(exif)).toBe(6);
    expect(exifOrientation(undefined)).toBe(1);
  });

  it('extracts JPEG metadata segments', () => {
    const exifPayload = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a];
    const app1 = [0xff, 0xe1, 0, exifPayload.length + 2, ...exifPayload];
    const sof = [0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0];
    const jpg = new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
    const m = readJpegMetadata(jpg);
    expect([...m.exif!]).toEqual([0x4d, 0x4d, 0, 0x2a]);
    expect(m.width).toBe(30);
    expect(m.height).toBe(20);
  });
});

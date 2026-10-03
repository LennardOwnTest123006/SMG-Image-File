/**
 * BMP (Windows bitmap) decoder and encoder.
 * Decodes 1/4/8-bit palettes (incl. RLE4/RLE8), 16/24/32-bit (incl. BI_BITFIELDS),
 * BITMAPCOREHEADER/INFOHEADER/V4/V5, bottom-up and top-down layouts.
 */
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';

function bad(msg: string): never {
  fail(SmgErrorCode.BAD_INPUT_IMAGE, `BMP: ${msg}`);
}

function maskShift(mask: number): [number, number] {
  if (mask === 0) return [0, 0];
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1) bits++;
  return [shift, bits];
}

export function decodeBmp(bytes: Uint8Array, maxPixels = 100_000_000): RgbaImage & { data: Uint8Array } {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) bad('bad signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataOffset = dv.getUint32(10, true);
  const hsize = dv.getUint32(14, true);
  let width: number, height: number, bpc: number, compression = 0, colorsUsed = 0;
  let rMask = 0, gMask = 0, bMask = 0, aMask = 0;
  let palEntrySize = 4;
  if (hsize === 12) {
    width = dv.getUint16(18, true);
    height = dv.getInt16(20, true);
    bpc = dv.getUint16(24, true);
    palEntrySize = 3;
  } else if (hsize >= 40) {
    if (bytes.length < 14 + hsize) bad('truncated header');
    width = dv.getInt32(18, true);
    height = dv.getInt32(22, true);
    bpc = dv.getUint16(28, true);
    compression = dv.getUint32(30, true);
    colorsUsed = dv.getUint32(46, true);
    if (compression === 3 || compression === 6) {
      if (hsize >= 52 || 14 + hsize + 12 <= bytes.length) {
        rMask = dv.getUint32(54, true);
        gMask = dv.getUint32(58, true);
        bMask = dv.getUint32(62, true);
        if (hsize >= 56 || compression === 6) aMask = dv.getUint32(66, true);
      }
    }
  } else bad(`unsupported header size ${hsize}`);
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0) bad('invalid dimensions');
  if (width * height > maxPixels) fail(SmgErrorCode.LIMIT_EXCEEDED, `BMP has ${width * height} pixels; limit is ${maxPixels}`);
  const out = new Uint8Array(width * height * 4);
  const rowOf = (r: number) => (topDown ? r : height - 1 - r);
  // palette
  let palette: Uint8Array | null = null;
  if (bpc <= 8) {
    const n = colorsUsed || 1 << bpc;
    const ps = 14 + hsize + (compression === 3 && hsize === 40 ? 12 : 0);
    palette = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o = ps + i * palEntrySize;
      if (o + 2 >= bytes.length) break;
      palette[i * 4] = bytes[o + 2];
      palette[i * 4 + 1] = bytes[o + 1];
      palette[i * 4 + 2] = bytes[o];
      palette[i * 4 + 3] = 255;
    }
  }
  const put = (x: number, y: number, ix: number) => {
    if (x >= width || y >= height) return;
    const o = (rowOf(y) * width + x) * 4;
    const p = (ix * 4) % (palette!.length || 4);
    out[o] = palette![p];
    out[o + 1] = palette![p + 1];
    out[o + 2] = palette![p + 2];
    out[o + 3] = 255;
  };
  if (compression === 1 || compression === 2) {
    // RLE8 / RLE4
    const rle4 = compression === 2;
    let p = dataOffset, x = 0, y = 0;
    while (p + 1 < bytes.length && y < height) {
      const a = bytes[p++], b = bytes[p++];
      if (a > 0) {
        for (let i = 0; i < a; i++) put(x++, y, rle4 ? (i & 1 ? b & 15 : b >> 4) : b);
      } else if (b === 0) { x = 0; y++; }
      else if (b === 1) break;
      else if (b === 2) { x += bytes[p++]; y += bytes[p++]; }
      else {
        for (let i = 0; i < b; i++) {
          const v = rle4 ? (i & 1 ? bytes[p + (i >> 1)] & 15 : bytes[p + (i >> 1)] >> 4) : bytes[p + i];
          put(x++, y, v);
        }
        const used = rle4 ? (b + 1) >> 1 : b;
        p += used + (used & 1);
      }
    }
    return { width, height, data: out };
  }
  if (compression !== 0 && compression !== 3 && compression !== 6) bad(`unsupported compression ${compression}`);
  const stride = Math.ceil((width * bpc) / 32) * 4;
  if (dataOffset + stride * height > bytes.length) bad('pixel data truncated');
  if (bpc === 16 && compression === 0) { rMask = 0x7c00; gMask = 0x03e0; bMask = 0x001f; }
  if (bpc === 32 && compression === 0) { rMask = 0x00ff0000; gMask = 0x0000ff00; bMask = 0x000000ff; aMask = 0; }
  const [rs, rb] = maskShift(rMask), [gs, gb] = maskShift(gMask), [bs, bbits] = maskShift(bMask), [as, ab] = maskShift(aMask);
  const scale = (v: number, bits: number) => (bits === 0 ? 255 : bits >= 8 ? v >>> (bits - 8) : Math.round((v * 255) / ((1 << bits) - 1)));
  let anyAlpha = false;
  for (let r = 0; r < height; r++) {
    const row = dataOffset + r * stride;
    const y = topDown ? r : height - 1 - r;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpc <= 8) {
        const bit = x * bpc;
        const ix = (bytes[row + (bit >> 3)] >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
        const p = ix * 4;
        out[o] = palette![p] ?? 0;
        out[o + 1] = palette![p + 1] ?? 0;
        out[o + 2] = palette![p + 2] ?? 0;
        out[o + 3] = 255;
      } else if (bpc === 24) {
        const p = row + x * 3;
        out[o] = bytes[p + 2];
        out[o + 1] = bytes[p + 1];
        out[o + 2] = bytes[p];
        out[o + 3] = 255;
      } else if (bpc === 16 || bpc === 32) {
        const v = bpc === 16 ? dv.getUint16(row + x * 2, true) : dv.getUint32(row + x * 4, true);
        out[o] = scale((v & rMask) >>> rs, rb);
        out[o + 1] = scale((v & gMask) >>> gs, gb);
        out[o + 2] = scale((v & bMask) >>> bs, bbits);
        out[o + 3] = aMask ? scale((v & aMask) >>> as, ab) : 255;
        if (aMask && out[o + 3] !== 0) anyAlpha = true;
      } else bad(`unsupported bit count ${bpc}`);
    }
  }
  // Some writers set an alpha mask but leave alpha at 0 everywhere: treat as opaque.
  if (aMask && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width, height, data: out };
}

/** Encode as 24-bit (opaque) or 32-bit BGRA with a BITMAPV4HEADER (alpha). */
export function encodeBmp(img: RgbaImage): Uint8Array {
  const { width: w, height: h, data: d } = img;
  let opaque = true;
  for (let p = 3; p < d.length; p += 4) if (d[p] !== 255) { opaque = false; break; }
  const bpc = opaque ? 24 : 32;
  const hsize = opaque ? 40 : 108;
  const stride = Math.ceil((w * bpc) / 32) * 4;
  const offset = 14 + hsize;
  const size = offset + stride * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, hsize, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, bpc, true);
  dv.setUint32(30, opaque ? 0 : 3, true);
  dv.setUint32(34, stride * h, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  if (!opaque) {
    dv.setUint32(54, 0x00ff0000, true);
    dv.setUint32(58, 0x0000ff00, true);
    dv.setUint32(62, 0x000000ff, true);
    dv.setUint32(66, 0xff000000, true);
    dv.setUint32(70, 0x73524742, true); // 'sRGB'
  }
  for (let y = 0; y < h; y++) {
    const row = offset + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const o = row + x * (bpc >> 3);
      out[o] = d[p + 2];
      out[o + 1] = d[p + 1];
      out[o + 2] = d[p];
      if (!opaque) out[o + 3] = d[p + 3];
    }
  }
  return out;
}

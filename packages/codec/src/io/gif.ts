/**
 * GIF decoder (GIF87a/GIF89a) with full frame composition: LZW decoding,
 * local/global colour tables, interlacing, transparency and disposal methods.
 * Returns every frame as a full-canvas RGBA image.
 */
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';

export interface GifFrame {
  image: RgbaImage & { data: Uint8Array };
  /** Frame delay in milliseconds. */
  delayMs: number;
  index: number;
}

export interface GifDecodeResult {
  width: number;
  height: number;
  frames: GifFrame[];
  /** Netscape loop count (0 = infinite), or null if absent. */
  loopCount: number | null;
}

function bad(msg: string): never {
  fail(SmgErrorCode.BAD_INPUT_IMAGE, `GIF: ${msg}`);
}

function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 11) bad('invalid LZW code size');
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const lengthOf = new Uint16Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let prev = -1;
  let bits = 0, acc = 0, op = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; lengthOf[i] = 1; }
  for (let p = 0; p < data.length && op < pixelCount; ) {
    while (bits < codeSize && p < data.length) { acc |= data[p++] << bits; bits += 8; }
    if (bits < codeSize) break;
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;
    if (code === clear) { codeSize = minCodeSize + 1; next = clear + 2; prev = -1; continue; }
    if (code === eoi) break;
    let c = code;
    let first: number;
    if (prev === -1) {
      if (code >= clear) bad('invalid first LZW code');
      out[op++] = code;
      prev = code;
      continue;
    }
    let sp = 0;
    if (code >= next) {
      if (code !== next) bad('invalid LZW code');
      // KwKwK case: emit prev + first(prev)
      c = prev;
    }
    while (c >= 0) { stack[sp++] = suffix[c]; c = prefix[c]; if (sp > 4096) bad('corrupt LZW chain'); }
    first = stack[sp - 1];
    if (code >= next) {
      // append first char at the end
      for (let i = sp - 1; i >= 0 && op < pixelCount; i--) out[op++] = stack[i];
      if (op < pixelCount) out[op++] = first;
    } else {
      for (let i = sp - 1; i >= 0 && op < pixelCount; i--) out[op++] = stack[i];
    }
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      lengthOf[next] = lengthOf[prev] + 1;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

export interface GifDecodeOptions {
  maxFrames?: number;
  maxPixels?: number;
}

export function decodeGif(bytes: Uint8Array, opts: GifDecodeOptions = {}): GifDecodeResult {
  const maxFrames = opts.maxFrames ?? 500;
  const maxPixels = opts.maxPixels ?? 100_000_000;
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') bad('bad signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint16(6, true);
  const height = dv.getUint16(8, true);
  if (!width || !height) bad('invalid dimensions');
  if (width * height > maxPixels) fail(SmgErrorCode.LIMIT_EXCEEDED, `GIF canvas has ${width * height} pixels; limit is ${maxPixels}`);
  const flags = bytes[10];
  let p = 13;
  let gct: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    gct = bytes.subarray(p, p + n * 3);
    p += n * 3;
  }
  const canvas = new Uint8Array(width * height * 4);
  const frames: GifFrame[] = [];
  let transparentIndex = -1;
  let delayMs = 0;
  let disposal = 0;
  let loopCount: number | null = null;
  let totalFramePixels = 0;
  const readSubBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let len = 0;
    while (p < bytes.length) {
      const n = bytes[p++];
      if (n === 0) break;
      parts.push(bytes.subarray(p, p + n));
      len += n;
      p += n;
    }
    const out = new Uint8Array(len);
    let o = 0;
    for (const s of parts) { out.set(s, o); o += s.length; }
    return out;
  };
  while (p < bytes.length) {
    const b = bytes[p++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        const size = bytes[p];
        const pf = bytes[p + 1];
        delayMs = dv.getUint16(p + 2, true) * 10;
        transparentIndex = pf & 1 ? bytes[p + 4] : -1;
        disposal = (pf >> 2) & 7;
        p += size + 1;
        readSubBlocks();
      } else if (label === 0xff) {
        const size = bytes[p];
        const app = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + Math.min(size, 11)));
        p += size + 1;
        const data = readSubBlocks();
        if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && data.length >= 3 && data[0] === 1) loopCount = data[1] | (data[2] << 8);
      } else readSubBlocks();
      continue;
    }
    if (b !== 0x2c) {
      if (frames.length > 0) break; // trailing garbage after valid frames
      bad(`unexpected block 0x${b.toString(16)}`);
    }
    const fx = dv.getUint16(p, true), fy = dv.getUint16(p + 2, true);
    const fw = dv.getUint16(p + 4, true), fh = dv.getUint16(p + 6, true);
    const ff = bytes[p + 8];
    p += 9;
    let ct = gct;
    if (ff & 0x80) {
      const n = 2 << (ff & 7);
      ct = bytes.subarray(p, p + n * 3);
      p += n * 3;
    }
    if (!ct) bad('no colour table');
    const interlaced = (ff & 0x40) !== 0;
    const minCode = bytes[p++];
    totalFramePixels += fw * fh;
    if (totalFramePixels > maxPixels * 4) fail(SmgErrorCode.LIMIT_EXCEEDED, 'GIF animation is too large');
    const indices = lzwDecode(minCode, readSubBlocks(), fw * fh);
    const before = disposal === 3 ? canvas.slice() : null;
    // map interlaced rows
    const rowMap = new Int32Array(fh);
    if (interlaced) {
      let r = 0;
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < fh; y += step) rowMap[r++] = y;
    } else for (let y = 0; y < fh; y++) rowMap[y] = y;
    for (let r = 0; r < fh; r++) {
      const y = fy + rowMap[r];
      if (y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const cx = fx + x;
        if (cx >= width) continue;
        const ix = indices[r * fw + x];
        if (ix === transparentIndex) continue;
        if (ix * 3 + 2 >= ct.length) continue;
        const o = (y * width + cx) * 4;
        canvas[o] = ct[ix * 3];
        canvas[o + 1] = ct[ix * 3 + 1];
        canvas[o + 2] = ct[ix * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    frames.push({ image: { width, height, data: canvas.slice() }, delayMs, index: frames.length });
    if (frames.length >= maxFrames) break;
    // dispose
    if (disposal === 2) {
      for (let y = fy; y < Math.min(height, fy + fh); y++) canvas.fill(0, (y * width + fx) * 4, (y * width + Math.min(width, fx + fw)) * 4);
    } else if (disposal === 3 && before) canvas.set(before);
    transparentIndex = -1;
    delayMs = 0;
    disposal = 0;
  }
  if (frames.length === 0) bad('no image frames');
  return { width, height, frames, loopCount };
}

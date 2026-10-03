/**
 * PNG decoder/encoder (pure TypeScript, inflate/deflate via fflate).
 *
 * Decoding yields exact 8-bit RGBA (no colour management, no premultiply), so
 * PNG → SMG lossless conversions are bit-exact. 16-bit samples are reduced to
 * their high byte; `reducedPrecision` reports when that happened.
 */
import { unzlibSync, zlibSync } from 'fflate';
import { crc32 } from '../crc32.ts';
import { fail, SmgErrorCode } from '../errors.ts';
import type { RgbaImage } from '../image.ts';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngDecodeResult {
  image: RgbaImage & { data: Uint8Array };
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  /** True if 16-bit samples were reduced to 8 bits. */
  reducedPrecision: boolean;
  icc?: Uint8Array;
  exif?: Uint8Array;
  text: Record<string, string>;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function bad(msg: string): never {
  fail(SmgErrorCode.BAD_INPUT_IMAGE, `PNG: ${msg}`);
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array, maxPixels = 100_000_000): PngDecodeResult {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) bad('bad signature');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let icc: Uint8Array | undefined;
  let exif: Uint8Array | undefined;
  const text: Record<string, string> = {};
  const latin1 = new TextDecoder('latin1');
  while (pos + 12 <= bytes.length) {
    const len = u32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (pos + 12 + len > bytes.length) bad(`chunk ${type} truncated`);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (crc32(bytes, pos + 4, pos + 8 + len) !== u32(bytes, pos + 8 + len)) bad(`CRC mismatch in ${type}`);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'iCCP') {
      const z = data.indexOf(0);
      if (z > 0 && data[z + 1] === 0) {
        try {
          icc = unzlibSync(data.subarray(z + 2));
        } catch {
          /* ignore broken profile */
        }
      }
    } else if (type === 'eXIf') exif = data.slice();
    else if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) text[latin1.decode(data.subarray(0, z))] = latin1.decode(data.subarray(z + 1));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0 && data[z + 1] === 0) {
        let p = z + 3;
        p = data.indexOf(0, p) + 1; // language
        p = data.indexOf(0, p) + 1; // translated keyword
        if (p > 0) text[latin1.decode(data.subarray(0, z))] = new TextDecoder().decode(data.subarray(p));
      }
    } else if (type === 'IEND') break;
  }
  if (!width || !height) bad('missing IHDR');
  if (width * height > maxPixels) fail(SmgErrorCode.LIMIT_EXCEEDED, `PNG has ${width * height} pixels; limit is ${maxPixels}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) bad(`unsupported colour type ${colorType}`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) bad(`unsupported bit depth ${bitDepth}`);
  if (colorType === 3 && !palette) bad('missing PLTE');
  let total = 0;
  for (const c of idat) total += c.length;
  const zdata = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    zdata.set(c, o);
    o += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(zdata);
  } catch (e) {
    bad(`corrupt image data (${(e as Error).message})`);
  }
  const out = new Uint8Array(width * height * 4);
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  let rp = 0;
  const maxv = (1 << bitDepth) - 1;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * channels * bitDepth) / 8);
    let prev = new Uint8Array(stride);
    let cur = new Uint8Array(stride);
    for (let py = 0; py < ph; py++) {
      if (rp + 1 + stride > raw.length) bad('image data too short');
      const ft = raw[rp++];
      cur.set(raw.subarray(rp, rp + stride));
      rp += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        switch (ft) {
          case 0: break;
          case 1: cur[i] = (cur[i] + a) & 255; break;
          case 2: cur[i] = (cur[i] + b) & 255; break;
          case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
          case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 255; break;
          default: bad(`invalid filter type ${ft}`);
        }
      }
      const y = y0 + py * dy;
      for (let px = 0; px < pw; px++) {
        const x = x0 + px * dx;
        const op = (y * width + x) * 4;
        const sample = (ch: number): number => {
          const idx = px * channels + ch;
          if (bitDepth === 8) return cur[idx];
          if (bitDepth === 16) return (cur[idx * 2] << 8) | cur[idx * 2 + 1];
          const bitPos = idx * bitDepth;
          return (cur[bitPos >> 3] >> (8 - bitDepth - (bitPos & 7))) & maxv;
        };
        const to8 = (v: number): number => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / maxv));
        if (colorType === 3) {
          const ix = sample(0);
          const pe = ix * 3;
          if (pe + 2 >= palette!.length) bad('palette index out of range');
          out[op] = palette![pe];
          out[op + 1] = palette![pe + 1];
          out[op + 2] = palette![pe + 2];
          out[op + 3] = trns && ix < trns.length ? trns[ix] : 255;
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(0);
          const v = to8(g);
          out[op] = out[op + 1] = out[op + 2] = v;
          if (colorType === 4) out[op + 3] = to8(sample(1));
          else {
            const key = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
            out[op + 3] = g === key ? 0 : 255;
          }
        } else {
          const r = sample(0), g = sample(1), b = sample(2);
          out[op] = to8(r);
          out[op + 1] = to8(g);
          out[op + 2] = to8(b);
          if (colorType === 6) out[op + 3] = to8(sample(3));
          else {
            const t = trns && trns.length >= 6;
            out[op + 3] = t && r === ((trns![0] << 8) | trns![1]) && g === ((trns![2] << 8) | trns![3]) && b === ((trns![4] << 8) | trns![5]) ? 0 : 255;
          }
        }
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
  }
  return {
    image: { width, height, data: out },
    bitDepth,
    colorType,
    interlaced: interlace === 1,
    reducedPrecision: bitDepth === 16,
    icc,
    exif,
    text,
  };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export interface PngEncodeOptions {
  /** zlib level 0..9 (default 9). */
  level?: number;
  /** Embed tEXt entries. */
  text?: Record<string, string>;
  icc?: Uint8Array;
}

/** Encode RGBA (drops alpha / uses grayscale when lossless to do so). */
export function encodePng(img: RgbaImage, opts: PngEncodeOptions = {}): Uint8Array {
  const { width: w, height: h, data: d } = img;
  let opaque = true, gray = true;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] !== 255) opaque = false;
    if (d[p] !== d[p + 1] || d[p] !== d[p + 2]) gray = false;
  }
  const colorType = gray ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6]!;
  const stride = w * ch;
  const raw = new Uint8Array((stride + 1) * h);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const cand = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      const o = x * ch;
      if (colorType === 0) cur[o] = d[p];
      else if (colorType === 4) { cur[o] = d[p]; cur[o + 1] = d[p + 3]; }
      else { cur[o] = d[p]; cur[o + 1] = d[p + 1]; cur[o + 2] = d[p + 2]; if (ch === 4) cur[o + 3] = d[p + 3]; }
    }
    let bestType = 0, bestScore = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
        const pr = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pr) & 255;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = ft; best.set(cand); }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
    const t = prev; prev = cur; cur = t;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (opts.icc) {
    const name = new TextEncoder().encode('ICC profile');
    const z = zlibSync(opts.icc, { level: 9 });
    const body = new Uint8Array(name.length + 2 + z.length);
    body.set(name);
    body.set(z, name.length + 2);
    parts.push(chunk('iCCP', body));
  }
  for (const [k, v] of Object.entries(opts.text ?? {})) {
    const kb = new TextEncoder().encode(k.slice(0, 79));
    const vb = new TextEncoder().encode(v);
    const body = new Uint8Array(kb.length + 5 + vb.length);
    body.set(kb);
    body.set(vb, kb.length + 5); // iTXt: keyword\0 compressionFlag compressionMethod lang\0 translated\0 text
    parts.push(chunk('iTXt', body));
  }
  parts.push(chunk('IDAT', zlibSync(raw, { level: (opts.level ?? 9) as 9 })));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

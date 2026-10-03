/**
 * Reading and writing conventional image formats for the CLI.
 *
 * Built in (pure JS): SMG, PNG, BMP, GIF (all frames), JPEG (jpeg-js).
 * Optional (if the `sharp` package is installed): WebP, AVIF, TIFF, HEIC, SVG
 * input; WebP/AVIF output; reference encoders for `smg benchmark`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decode, type RgbaImage, type SmgMetadata, SmgError, SmgErrorCode } from '@smg/codec';
import {
  applyOrientation,
  decodeBmp,
  decodeGif,
  decodePng,
  detectFormat,
  encodeBmp,
  encodePng,
  exifOrientation,
  readJpegMetadata,
  type ImageFormat,
} from '@smg/codec/io';
import jpeg from 'jpeg-js';

type Img = RgbaImage & { data: Uint8Array };

export interface LoadedImage {
  image: Img;
  format: ImageFormat;
  metadata: SmgMetadata;
  notes: string[];
  frames?: Img[];
}

let sharpModule: unknown | null | undefined;

/** Lazily load sharp; returns null when it is not installed. */
export async function loadSharp(): Promise<any | null> {
  if (sharpModule !== undefined) return sharpModule as any;
  try {
    const mod = await import('sharp');
    sharpModule = (mod as any).default ?? mod;
  } catch {
    sharpModule = null;
  }
  return sharpModule as any;
}

function needSharp(what: string): never {
  throw new SmgError(SmgErrorCode.BAD_INPUT_IMAGE, `${what} requires the optional "sharp" package (npm install sharp)`);
}

export interface ReadOptions {
  /** GIF: which frame to read (default 0). */
  frame?: number;
  /** SVG rasterisation size. */
  width?: number;
  height?: number;
  maxPixels?: number;
}

export async function readImageFile(file: string, opts: ReadOptions = {}): Promise<LoadedImage> {
  const bytes = new Uint8Array(fs.readFileSync(file));
  return readImageBytes(bytes, opts);
}

export async function readImageBytes(bytes: Uint8Array, opts: ReadOptions = {}): Promise<LoadedImage> {
  const format = detectFormat(bytes);
  const notes: string[] = [];
  const maxPixels = opts.maxPixels ?? 100_000_000;
  switch (format) {
    case 'smg': {
      const r = decode(bytes, { maxPixels });
      return { image: r.image, format, metadata: r.info.metadata, notes };
    }
    case 'png': {
      const r = decodePng(bytes, maxPixels);
      if (r.reducedPrecision) notes.push('16-bit PNG samples were reduced to 8 bits (SMG v1 stores 8-bit channels).');
      const text = Object.keys(r.text).length ? r.text : undefined;
      return { image: r.image, format, metadata: { icc: r.icc, exif: r.exif, text }, notes };
    }
    case 'bmp':
      return { image: decodeBmp(bytes, maxPixels), format, metadata: {}, notes };
    case 'gif': {
      const g = decodeGif(bytes, { maxPixels });
      const idx = Math.min(g.frames.length - 1, Math.max(0, opts.frame ?? 0));
      if (g.frames.length > 1) notes.push(`GIF has ${g.frames.length} frames; using frame ${idx} (use --frames all to extract every frame).`);
      return { image: g.frames[idx].image, format, metadata: {}, notes, frames: g.frames.map((f) => f.image) };
    }
    case 'jpeg': {
      const meta = readJpegMetadata(bytes);
      let img: Img;
      try {
        const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: Math.ceil(maxPixels / 1e6) });
        img = { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
      } catch (e) {
        const sharp = await loadSharp();
        if (!sharp) throw new SmgError(SmgErrorCode.BAD_INPUT_IMAGE, `JPEG: ${(e as Error).message}`);
        img = await sharpRaw(sharp, bytes);
      }
      const o = exifOrientation(meta.exif);
      if (o !== 1) {
        img = applyOrientation(img, o);
        notes.push(`Applied EXIF orientation ${o}.`);
      }
      return { image: img, format, metadata: { icc: meta.icc, exif: meta.exif, xmp: meta.xmp }, notes };
    }
    case 'webp':
    case 'avif':
    case 'heic':
    case 'tiff': {
      const sharp = await loadSharp();
      if (!sharp) needSharp(`Reading ${format.toUpperCase()}`);
      return { image: await sharpRaw(sharp, bytes), format, metadata: {}, notes };
    }
    case 'svg': {
      const sharp = await loadSharp();
      if (!sharp) needSharp('Rasterising SVG');
      let s = sharp(Buffer.from(bytes), { density: 96 });
      if (opts.width || opts.height) s = s.resize({ width: opts.width, height: opts.height, fit: 'fill' });
      const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      notes.push(`SVG rasterised at ${info.width}×${info.height}.`);
      return { image: { width: info.width, height: info.height, data: new Uint8Array(data) }, format, metadata: {}, notes };
    }
    default:
      throw new SmgError(SmgErrorCode.BAD_INPUT_IMAGE, 'unrecognised image format');
  }
}

async function sharpRaw(sharp: any, bytes: Uint8Array): Promise<Img> {
  const { data, info } = await sharp(Buffer.from(bytes)).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

export type OutputFormat = 'png' | 'bmp' | 'jpeg' | 'webp' | 'avif';

export function formatFromPath(file: string): OutputFormat | 'smg' | null {
  const ext = path.extname(file).toLowerCase();
  return ({ '.png': 'png', '.bmp': 'bmp', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.avif': 'avif', '.smg': 'smg' } as const)[ext as '.png'] ?? null;
}

/** Composite over a background colour (for formats without alpha). */
export function flatten(img: RgbaImage, bg: [number, number, number] = [255, 255, 255]): Img {
  const out = new Uint8Array(img.data.length);
  for (let p = 0; p < out.length; p += 4) {
    const a = img.data[p + 3] / 255;
    out[p] = Math.round(img.data[p] * a + bg[0] * (1 - a));
    out[p + 1] = Math.round(img.data[p + 1] * a + bg[1] * (1 - a));
    out[p + 2] = Math.round(img.data[p + 2] * a + bg[2] * (1 - a));
    out[p + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

export async function encodeConventional(img: RgbaImage, format: OutputFormat, quality = 90, metadata?: SmgMetadata): Promise<Uint8Array> {
  switch (format) {
    case 'png':
      return encodePng(img, { icc: metadata?.icc, text: metadata?.text });
    case 'bmp':
      return encodeBmp(img);
    case 'jpeg': {
      const flat = flatten(img);
      const sharp = await loadSharp();
      if (sharp) {
        return new Uint8Array(await sharp(Buffer.from(flat.data), { raw: { width: img.width, height: img.height, channels: 4 } }).removeAlpha().jpeg({ quality, mozjpeg: true }).toBuffer());
      }
      return new Uint8Array(jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(flat.data) }, quality).data);
    }
    case 'webp':
    case 'avif': {
      const sharp = await loadSharp();
      if (!sharp) needSharp(`Writing ${format.toUpperCase()}`);
      const s = sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } });
      return new Uint8Array(await (format === 'webp' ? s.webp({ quality }) : s.avif({ quality })).toBuffer());
    }
  }
}

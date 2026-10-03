/**
 * Loading user files into RGBA pixels and exporting pixels to files — all in
 * the browser. PNG/BMP/GIF/SMG use SMG's exact pure-JS decoders (in a worker);
 * JPEG/WebP/AVIF use the browser's native decoder; SVG is rasterised at a
 * user-selected size.
 */
import type { RgbaImage, SmgInfo, SmgMetadata, WorkerEncodeOptionsAlias } from './types-shim.ts';
import { detectFormat, FORMAT_LABELS, readJpegMetadata, type ImageFormat } from '@smg/codec/io';
import { codec, fromWire } from './codec-client.ts';

export const LIMITS = {
  /** Maximum accepted file size. */
  maxFileBytes: 200 * 1024 * 1024,
  /** Maximum decoded pixels per image (keeps memory use reasonable on phones). */
  maxPixels: 40_000_000,
  /** Maximum SVG rasterisation side. */
  maxSvgSide: 8192,
};

export type Img = RgbaImage & { data: Uint8Array };

export interface LoadedFile {
  id: string;
  file: File;
  name: string;
  bytes: number;
  format: ImageFormat;
  formatLabel: string;
  frames: Img[];
  delays?: number[];
  metadata: SmgMetadata;
  smgInfo?: SmgInfo;
  notes: string[];
}

export class LoadError extends Error {}

let uid = 0;
export const newId = () => `${Date.now().toString(36)}-${(uid++).toString(36)}`;

/** Read intrinsic SVG size from width/height or viewBox. */
export function svgIntrinsicSize(text: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new LoadError('Not a valid SVG document');
  const num = (v: string | null) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : NaN);
  let w = num(svg.getAttribute('width'));
  let h = num(svg.getAttribute('height'));
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  if ((!w || !h) && vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (w && !h) h = (w * vb[3]) / vb[2];
    else if (h && !w) w = (h * vb[2]) / vb[3];
    else { w = vb[2]; h = vb[3]; }
  }
  return { width: Math.round(w || 512), height: Math.round(h || 512) };
}

/** Rasterise SVG markup at the given size. */
export async function rasterizeSvg(text: string, width: number, height: number): Promise<Img> {
  width = Math.max(1, Math.min(LIMITS.maxSvgSide, Math.round(width)));
  height = Math.max(1, Math.min(LIMITS.maxSvgSide, Math.round(height)));
  // Force the requested size on the root element so the browser renders crisply.
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new LoadError('Not a valid SVG document');
  if (!svg.getAttribute('viewBox')) {
    const s = svgIntrinsicSize(text);
    svg.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`);
  }
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') ?? 'none');
  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, width, height);
    const d = ctx.getImageData(0, 0, width, height);
    return { width, height, data: new Uint8Array(d.data.buffer) };
  } catch {
    throw new LoadError('The browser could not render this SVG (external resources or invalid markup?)');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode with the browser's native decoder (JPEG, WebP, AVIF, …). */
export async function decodeNative(blob: Blob): Promise<Img> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    throw new LoadError('This browser cannot decode the image (format not supported here).');
  }
  if (bmp.width * bmp.height > LIMITS.maxPixels) {
    bmp.close();
    throw new LoadError(`Image is too large (${bmp.width}×${bmp.height}); limit is ${(LIMITS.maxPixels / 1e6).toFixed(0)} megapixels.`);
  }
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: new Uint8Array(d.data.buffer) };
}

export interface LoadOptions {
  svgSize?: { width: number; height: number };
  signal?: AbortSignal;
}

export async function loadFile(file: File, opts: LoadOptions = {}): Promise<LoadedFile> {
  if (file.size > LIMITS.maxFileBytes) throw new LoadError(`File is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  if (file.size === 0) throw new LoadError('File is empty.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);
  const base: Omit<LoadedFile, 'frames' | 'metadata' | 'notes'> = { id: newId(), file, name: file.name, bytes: file.size, format, formatLabel: FORMAT_LABELS[format] };
  switch (format) {
    case 'png':
    case 'bmp':
    case 'gif':
    case 'smg': {
      try {
        const r = await codec.decodeFile(bytes, LIMITS.maxPixels, { signal: opts.signal });
        return { ...base, frames: r.frames.map(fromWire), delays: r.delays, metadata: r.metadata, smgInfo: r.smgInfo, notes: r.notes };
      } catch (e) {
        throw new LoadError(cleanError(e));
      }
    }
    case 'jpeg': {
      const meta = readJpegMetadata(bytes);
      const img = await decodeNative(file);
      return { ...base, frames: [img], metadata: { icc: meta.icc, exif: meta.exif, xmp: meta.xmp }, notes: [] };
    }
    case 'webp':
    case 'avif':
    case 'heic':
    case 'tiff':
    case 'ico': {
      const img = await decodeNative(file);
      const notes = format === 'webp' || format === 'avif' ? ['Decoded by the browser; semi-transparent colours may be rounded by canvas premultiplication.'] : [];
      return { ...base, frames: [img], metadata: {}, notes };
    }
    case 'svg': {
      const text = new TextDecoder().decode(bytes);
      const size = opts.svgSize ?? svgIntrinsicSize(text);
      const img = await rasterizeSvg(text, size.width, size.height);
      return { ...base, frames: [img], metadata: {}, notes: [`SVG rasterised at ${img.width}×${img.height}.`] };
    }
    default:
      throw new LoadError('Unrecognised file type. Supported: SMG, PNG, JPEG, WebP, AVIF, GIF, BMP, SVG.');
  }
}

export function cleanError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.replace(/^SMG_E_[A-Z_]+:\s*/, '');
}

// ---------- export ----------

export type ExportFormat = 'smg' | 'png' | 'jpeg' | 'webp' | 'avif' | 'bmp';

export const EXPORT_LABELS: Record<ExportFormat, string> = { smg: 'SMG', png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', bmp: 'BMP' };
export const EXPORT_EXT: Record<ExportFormat, string> = { smg: '.smg', png: '.png', jpeg: '.jpg', webp: '.webp', avif: '.avif', bmp: '.bmp' };
export const EXPORT_MIME: Record<ExportFormat, string> = { smg: 'image/x-smg', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };

export function imageToCanvas(img: RgbaImage, flattenOn?: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  const id = new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength).slice(), img.width, img.height);
  if (flattenOn) {
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext('2d')!.putImageData(id, 0, 0);
    ctx.fillStyle = flattenOn;
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(tmp, 0, 0);
  } else ctx.putImageData(id, 0, 0);
  return c;
}

const encodeSupport = new Map<string, boolean>();

/** Whether this browser's canvas can encode the given MIME type. */
export async function canEncode(mime: string): Promise<boolean> {
  if (encodeSupport.has(mime)) return encodeSupport.get(mime)!;
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, 0.8));
  const ok = !!blob && blob.type === mime;
  encodeSupport.set(mime, ok);
  return ok;
}

export async function canvasEncode(img: RgbaImage, mime: string, quality: number): Promise<Blob> {
  const c = imageToCanvas(img, mime === 'image/jpeg' ? '#ffffff' : undefined);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, quality / 100));
  if (!blob || blob.type !== mime) throw new LoadError(`This browser cannot encode ${mime.replace('image/', '').toUpperCase()}.`);
  return blob;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  smg?: Awaited<ReturnType<typeof codec.encode>>;
}

export async function exportImage(
  img: RgbaImage,
  format: ExportFormat,
  opts: { quality?: number; smg?: WorkerEncodeOptionsAlias; metadata?: SmgMetadata; onProgress?: (p: number, s: string) => void; signal?: AbortSignal; withMetrics?: boolean } = {},
): Promise<ExportResult> {
  const q = opts.quality ?? 90;
  switch (format) {
    case 'smg': {
      const r = await codec.encode(img, { ...opts.smg, metadata: opts.metadata }, { onProgress: opts.onProgress, signal: opts.signal, withMetrics: opts.withMetrics });
      return { blob: new Blob([r.bytes as BlobPart], { type: EXPORT_MIME.smg }), bytes: r.bytes.length, smg: r };
    }
    case 'png': {
      const png = await codec.encodePng(img, opts.metadata?.text);
      return { blob: new Blob([png as BlobPart], { type: 'image/png' }), bytes: png.length };
    }
    case 'bmp': {
      const bmp = await codec.encodeBmp(img);
      return { blob: new Blob([bmp as BlobPart], { type: 'image/bmp' }), bytes: bmp.length };
    }
    default: {
      const blob = await canvasEncode(img, EXPORT_MIME[format], q);
      return { blob, bytes: blob.size };
    }
  }
}

export function replaceExt(name: string, ext: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return (base || 'image') + ext;
}

import { writeContainer, ChunkTag, type Header } from './container.ts';
import { crc32 } from './crc32.ts';
import { chooseTransform, encodeLossless, Transform } from './codecs/lossless.ts';
import { buildPalette, encodePalette } from './codecs/palette.ts';
import {
  codeWavelet,
  decodeWavelet,
  DEFAULT_CHROMA_SCALE,
  prepareWavelet,
  qualityForStep,
  stepForQuality,
  SUBSAMPLE_BELOW_QUALITY,
  type WaveletPrepared,
} from './codecs/wavelet.ts';
import { fail, SmgErrorCode } from './errors.ts';
import { analyzeImage, assertImage, type ImageAnalysis, type RgbaImage } from './image.ts';
import { encodeChecksum, encodeProfile, encodeText, type SmgMetadata } from './metadata.ts';
import { psnr } from './metrics.ts';
import { quantizeImage } from './quantize.ts';
import { CODEC_NAMES, CodecId, COLOR_MODEL_NAMES, ColorModel, HeadFlags } from './types.ts';

export type SmgMode = 'auto' | 'lossless' | 'lossy' | 'palette';
export type SmgPreset = 'auto' | 'photo' | 'screenshot' | 'logo' | 'illustration' | 'ui' | 'smallest' | 'archive';

export interface EncodeOptions {
  /** Compression mode. Default: from preset, otherwise 'auto'. */
  mode?: SmgMode;
  /** Intelligent preset that fills in mode/quality/effort defaults. */
  preset?: SmgPreset;
  /** Lossy quality 1..100 (default 80). */
  quality?: number;
  /** Compression effort 1..9 (default 5): more candidates, slower. */
  effort?: number;
  /** Target file size in bytes. Searches the best quality that fits (lossy/auto/palette). */
  targetSize?: number;
  /** Palette mode: maximum colours 2..256 (default 256). */
  maxColors?: number;
  /** Palette mode: Floyd–Steinberg dithering (default false). */
  dither?: boolean;
  /**
   * Keep the RGB values of fully transparent pixels exactly (default true).
   * When false, they are normalised for better compression; the result is
   * visually lossless but no longer bit-exact.
   */
  exactTransparent?: boolean;
  /** Metadata to embed (ignored when stripMetadata is true). */
  metadata?: SmgMetadata;
  /** Drop all metadata (text, ICC, EXIF, XMP). */
  stripMetadata?: boolean;
  /** Store a CRC-32 of the decoded pixels for exact encodes (default true). */
  checksum?: boolean;
  /** Progress callback (0..1). */
  onProgress?: (fraction: number, stage: string) => void;
  /** Cooperative cancellation. */
  signal?: { aborted: boolean };
}

export interface CandidateReport {
  label: string;
  codec: number;
  bytes: number;
  exact: boolean;
  quality: number | null;
  timeMs: number;
  chosen: boolean;
}

export interface EncodeInfo {
  width: number;
  height: number;
  codec: number;
  codecName: string;
  colorModel: number;
  colorModelName: string;
  /** True when decoding reproduces the input pixels bit-exactly. */
  exact: boolean;
  /** True when only the RGB of fully transparent pixels changed. */
  visuallyLossless: boolean;
  quality: number | null;
  mode: SmgMode;
  preset: SmgPreset | null;
  /** Uncompressed RGBA size (width × height × 4). */
  rawBytes: number;
  /** Size of the .smg file. */
  outputBytes: number;
  metadataBytes: number;
  candidates: CandidateReport[];
  targetSize: number | null;
  targetMet: boolean | null;
  analysis: ImageAnalysis;
  timeMs: number;
}

export interface EncodeResult {
  bytes: Uint8Array;
  info: EncodeInfo;
}

interface ResolvedOptions {
  mode: SmgMode;
  quality: number;
  effort: number;
  maxColors: number;
  dither: boolean;
}

export const PRESETS: Record<SmgPreset, { label: string; description: string; mode: SmgMode; quality: number; effort: number; maxColors?: number; dither?: boolean }> = {
  auto: { label: 'Auto', description: 'Analyses the image and picks the best codec.', mode: 'auto', quality: 80, effort: 5 },
  photo: { label: 'Photo', description: 'Wavelet lossy coding tuned for natural images.', mode: 'lossy', quality: 80, effort: 5 },
  screenshot: { label: 'Screenshot', description: 'Lossless: keeps text and UI pixels crisp.', mode: 'lossless', quality: 100, effort: 6 },
  logo: { label: 'Logo / Icon', description: 'Palette coding (≤256 colours) with transparency.', mode: 'palette', quality: 100, effort: 6, maxColors: 256 },
  illustration: { label: 'Illustration', description: 'Chooses between palette, lossless and lossy.', mode: 'auto', quality: 88, effort: 6 },
  ui: { label: 'UI asset', description: 'Lossless with automatic palette detection.', mode: 'lossless', quality: 100, effort: 7 },
  smallest: { label: 'Smallest', description: 'Aggressive lossy compression for minimum size.', mode: 'lossy', quality: 55, effort: 7 },
  archive: { label: 'Archive', description: 'Bit-exact lossless, maximum effort.', mode: 'lossless', quality: 100, effort: 9 },
};

function resolve(opts: EncodeOptions): ResolvedOptions {
  const p = opts.preset ? PRESETS[opts.preset] : undefined;
  if (opts.preset && !p) fail(SmgErrorCode.INVALID_ARGUMENT, `unknown preset "${opts.preset}"`);
  const mode = opts.mode ?? p?.mode ?? 'auto';
  if (!['auto', 'lossless', 'lossy', 'palette'].includes(mode)) fail(SmgErrorCode.INVALID_ARGUMENT, `unknown mode "${mode}"`);
  const quality = clampInt(opts.quality ?? p?.quality ?? 80, 1, 100);
  const effort = clampInt(opts.effort ?? p?.effort ?? 5, 1, 9);
  const maxColors = clampInt(opts.maxColors ?? p?.maxColors ?? 256, 2, 256);
  return { mode, quality, effort, maxColors, dither: opts.dither ?? p?.dither ?? false };
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) fail(SmgErrorCode.INVALID_ARGUMENT, `expected a number, got ${v}`);
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface Payload {
  codec: number;
  model: number;
  data: Uint8Array;
  exact: boolean;
  quality: number | null;
  flags: number;
  label: string;
  /** Pixels the decoder will reproduce, when known (for the checksum). */
  pixels?: RgbaImage;
}

/** Normalise the RGB of fully transparent pixels to black (0,0,0). */
function cleanTransparent(img: RgbaImage): { img: RgbaImage; changed: boolean } {
  const d = new Uint8Array(img.data);
  let changed = false;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] !== 0) continue;
    const r = 0, g = 0, b = 0;
    if (d[p] !== r || d[p + 1] !== g || d[p + 2] !== b) {
      d[p] = r; d[p + 1] = g; d[p + 2] = b;
      changed = true;
    }
  }
  return { img: { width: img.width, height: img.height, data: d }, changed };
}

function modelFor(a: ImageAnalysis): number {
  if (a.grayscale) return a.hasAlpha ? ColorModel.GRAY_ALPHA : ColorModel.GRAY;
  return a.hasAlpha ? ColorModel.RGBA : ColorModel.RGB;
}

/** Encode an RGBA image into an SMG file. */
export function encode(image: RgbaImage, options: EncodeOptions = {}): EncodeResult {
  const t0 = now();
  assertImage(image);
  const o = resolve(options);
  const progress = options.onProgress ?? (() => {});
  const checkAbort = () => {
    if (options.signal?.aborted) fail(SmgErrorCode.ABORTED, 'encoding was cancelled');
  };
  progress(0, 'Analysing image');
  let img = image;
  let analysis = analyzeImage(img);
  let cleaned = false;
  if (options.exactTransparent === false && analysis.hasAlpha) {
    const c = cleanTransparent(img);
    if (c.changed) {
      img = c.img;
      cleaned = true;
      analysis = analyzeImage(img);
    }
  }
  const model = modelFor(analysis);
  const candidates: Array<Payload & { timeMs: number }> = [];
  const run = (label: string, fn: () => Payload | null) => {
    checkAbort();
    const s = now();
    const r = fn();
    if (r) candidates.push({ ...r, label, timeMs: now() - s });
    return r;
  };

  // ---- candidate generators ----
  const chain = 8 + o.effort * 8;
  const lossless = (lz: boolean, transform?: Transform): Payload => {
    const t = transform ?? (model === ColorModel.GRAY || model === ColorModel.GRAY_ALPHA ? Transform.NONE : chooseTransform(img));
    return { codec: CodecId.LOSSLESS, model, data: encodeLossless(img, model, t, { lz, chain }), exact: true, quality: null, flags: 0, label: '', pixels: img };
  };
  const exactPalette = (): Payload | null => {
    if (analysis.uniqueColors < 0) return null;
    const pal = buildPalette(img, 256);
    if (!pal) return null;
    return { codec: CodecId.PALETTE, model, data: encodePalette(pal, img.width, img.height, model), exact: true, quality: null, flags: 0, label: '', pixels: img };
  };
  const quantPalette = (colors: number, dither: boolean): Payload => {
    const q = quantizeImage(img, { maxColors: colors, dither });
    const qa = analyzeImage(q);
    const qModel = modelFor(qa);
    const pal = buildPalette(q, 256)!;
    return { codec: CodecId.PALETTE, model: qModel, data: encodePalette(pal, q.width, q.height, qModel), exact: false, quality: null, flags: HeadFlags.QUANTIZED, label: '', pixels: q };
  };
  let prepCache: { sub: boolean; prep: WaveletPrepared } | null = null;
  const waveletPrep = (sub: boolean) => {
    if (!prepCache || prepCache.sub !== sub) {
      prepCache = { sub, prep: prepareWavelet(img, { subsample: sub, gray: analysis.grayscale, alpha: analysis.hasAlpha }) };
    }
    return prepCache.prep;
  };
  const waveletAt = (step: number): Payload => {
    const q = qualityForStep(step);
    const prep = waveletPrep(q < SUBSAMPLE_BELOW_QUALITY);
    return { codec: CodecId.WAVELET, model, data: codeWavelet(prep, step, DEFAULT_CHROMA_SCALE), exact: false, quality: q, flags: 0, label: '' };
  };

  const target = options.targetSize && options.targetSize > 0 ? Math.floor(options.targetSize) : null;
  const graphicLike = analysis.kind !== 'photo';
  const smallEnough = analysis.pixels <= 4_000_000;
  const containerOverhead = 64;
  const fits = (c: Payload) => target === null || c.data.length + containerOverhead <= target;
  /** Lossy candidates must reach this PSNR to qualify (set by the wavelet at the requested quality). */
  let psnrBar = Infinity;
  const psnrOf = (c: Payload): number => {
    if (c.exact) return Infinity;
    const dec = c.pixels ?? { width: img.width, height: img.height, data: decodeWavelet(c.data, img.width, img.height, analysis.hasAlpha, analysis.grayscale) };
    return psnr(img, dec);
  };
  const psnrs = new Map<Payload, number>();

  const runLossless = () => {
    // LZ (pixel-run copies) pays off on synthetic content; plain prediction on photos.
    const lzFirst = graphicLike;
    const tryAll = o.effort >= 8 && !analysis.grayscale;
    if (tryAll) {
      for (const t of [Transform.YCOCG, Transform.SUBGREEN, Transform.NONE]) run(`SMG-L${lzFirst ? '+LZ' : ''} (transform ${t})`, () => lossless(lzFirst, t));
    } else run(lzFirst ? 'SMG-L+LZ' : 'SMG-L', () => lossless(lzFirst));
    if (o.effort >= 7) run(lzFirst ? 'SMG-L' : 'SMG-L+LZ', () => lossless(!lzFirst));
    if (o.effort >= 3) run('SMG-P (exact palette)', exactPalette);
  };
  const runWaveletTarget = (): Payload => {
    // Binary search on log2(step) for the highest quality that fits.
    let lo = Math.log2(stepForQuality(100)), hi = Math.log2(stepForQuality(1));
    let best: Payload | null = null;
    for (let it = 0; it < 13; it++) {
      checkAbort();
      const mid = (lo + hi) / 2;
      const r = waveletAt(2 ** mid);
      if (r.data.length + containerOverhead <= target!) { best = r; hi = mid; } else lo = mid;
      progress(0.1 + (0.75 * (it + 1)) / 13, 'Searching quality for target size');
    }
    return run('SMG-W (target size)', () => best ?? waveletAt(2 ** hi))!;
  };

  if (o.mode === 'lossless') {
    progress(0.1, 'Lossless prediction');
    runLossless();
  } else if (o.mode === 'palette') {
    progress(0.1, 'Building palette');
    const exact = analysis.uniqueColors >= 0 && analysis.uniqueColors <= o.maxColors ? run('SMG-P (exact palette)', exactPalette) : null;
    if (!exact) {
      if (target !== null) {
        // Search the largest colour count that fits the target.
        let lo = 2, hi = o.maxColors, best: Payload | null = null;
        while (lo <= hi) {
          checkAbort();
          const mid = (lo + hi) >> 1;
          const r = quantPalette(mid, o.dither);
          if (r.data.length + containerOverhead <= target) { best = r; lo = mid + 1; } else hi = mid - 1;
          progress(0.1 + 0.8 * (1 - (hi - lo) / o.maxColors), 'Searching colour count');
        }
        run(`SMG-P (${best ? 'quantised' : 'minimum colours'})`, () => best ?? quantPalette(2, o.dither));
      } else run(`SMG-P (${o.maxColors} colours${o.dither ? ', dithered' : ''})`, () => quantPalette(o.maxColors, o.dither));
    }
    if (o.effort >= 7 && smallEnough) run('SMG-L+LZ', () => lossless(true));
  } else {
    // 'lossy' and 'auto': wavelet at the requested quality defines the quality bar.
    progress(0.1, 'Wavelet transform');
    const w = target !== null ? runWaveletTarget() : run(`SMG-W (q${o.quality})`, () => waveletAt(stepForQuality(o.quality)))!;
    const consider = graphicLike && (o.mode === 'auto' ? o.effort >= 2 : o.effort >= 4);
    if (consider) {
      psnrBar = psnrOf(w);
      psnrs.set(w, psnrBar);
      progress(0.8, 'Comparing exact candidates');
      run('SMG-P (exact palette)', exactPalette);
      if (smallEnough && (o.mode === 'auto' || o.effort >= 5)) run('SMG-L+LZ', () => lossless(true));
      if (o.mode === 'auto' && analysis.uniqueColors < 0 && smallEnough) {
        progress(0.9, 'Quantised palette candidate');
        const p = run('SMG-P (256 colours)', () => quantPalette(256, false))!;
        psnrs.set(p, psnrOf(p));
      }
    }
  }
  checkAbort();
  if (candidates.length === 0) fail(SmgErrorCode.INVALID_ARGUMENT, 'no encoding candidate was produced');

  // ---- choose ----
  // Smallest candidate that meets the quality bar (exact ones always do) and
  // the size target; exact wins ties.
  const meetsQuality = (c: Payload) => c.exact || c.codec === CodecId.WAVELET || (psnrs.get(c) ?? Infinity) >= psnrBar;
  let pool = candidates.filter((c) => meetsQuality(c) && fits(c));
  if (pool.length === 0) pool = candidates.filter(fits);
  if (pool.length === 0) pool = candidates;
  let chosen: Payload | null = null;
  for (const c of pool) {
    if (!chosen) chosen = c;
    else if (c.data.length < chosen.data.length || (c.data.length === chosen.data.length && c.exact && !chosen.exact)) chosen = c;
  }
  chosen = chosen!;

  // ---- container ----
  progress(0.95, 'Writing container');
  const exact = chosen.exact && !cleaned;
  let flags = chosen.flags;
  if (exact) flags |= HeadFlags.EXACT;
  if (cleaned && chosen.exact) flags |= HeadFlags.CLEANED_TRANSPARENT;
  const header: Header = {
    width: img.width,
    height: img.height,
    colorModel: chosen.model,
    bitDepth: 8,
    codec: chosen.codec,
    flags,
    quality: chosen.quality ?? 255,
  };
  const ancillary: Array<{ tag: string; payload: Uint8Array }> = [];
  const md = options.stripMetadata ? undefined : options.metadata;
  if (md?.icc && md.icc.length) ancillary.push({ tag: ChunkTag.PROFILE, payload: encodeProfile(md.icc) });
  if (md?.exif && md.exif.length) ancillary.push({ tag: ChunkTag.EXIF, payload: md.exif });
  if (md?.xmp) ancillary.push({ tag: ChunkTag.XMP, payload: new TextEncoder().encode(md.xmp) });
  if (md?.text && Object.keys(md.text).length) ancillary.push({ tag: ChunkTag.META, payload: encodeText(md.text) });
  const metadataBytes = ancillary.reduce((s, a) => s + a.payload.length + 9, 0);
  if ((options.checksum ?? true) && chosen.pixels) {
    ancillary.push({ tag: ChunkTag.CHECKSUM, payload: encodeChecksum(crc32(toU8(chosen.pixels.data))) });
  }
  const bytes = writeContainer({ header, data: chosen.data, ancillary });
  progress(1, 'Done');
  const reports: CandidateReport[] = candidates.map((c) => ({
    label: c.label,
    codec: c.codec,
    bytes: c.data.length,
    exact: c.exact && !cleaned,
    quality: c.quality,
    timeMs: Math.round(c.timeMs),
    chosen: c === chosen,
  }));
  return {
    bytes,
    info: {
      width: img.width,
      height: img.height,
      codec: chosen.codec,
      codecName: CODEC_NAMES[chosen.codec],
      colorModel: chosen.model,
      colorModelName: COLOR_MODEL_NAMES[chosen.model],
      exact,
      visuallyLossless: cleaned && chosen.exact,
      quality: chosen.quality,
      mode: o.mode,
      preset: options.preset ?? null,
      rawBytes: img.width * img.height * 4,
      outputBytes: bytes.length,
      metadataBytes,
      candidates: reports,
      targetSize: target,
      targetMet: target === null ? null : bytes.length <= target,
      analysis,
      timeMs: Math.round(now() - t0),
    },
  };
}

function toU8(d: Uint8Array | Uint8ClampedArray): Uint8Array {
  return d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

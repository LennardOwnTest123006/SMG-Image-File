/**
 * Benchmark results produced by `npm run bench` (bench/results/latest.json).
 * The site only displays numbers computed from this file — nothing is hard-coded.
 */
import report from '../../../../bench/results/latest.json';

export interface CodecResult {
  bytes: number;
  encodeMs: number;
  decodeMs: number;
  exact?: boolean;
  quality?: number | null;
  psnr?: number;
  ssim?: number;
  reachedTarget?: boolean;
  note?: string;
}

export interface ImageResult {
  file: string;
  category: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  sourceBytes: number;
  lossless: Record<string, CodecResult>;
  lossy: { targetSsim: number; smgQuality: number; results: Record<string, CodecResult> };
}

export interface Report {
  tool: string;
  generatedAt: string;
  machine: { cpu: string; cores: number; memoryGB: number; os: string; node: string };
  versions: Record<string, string>;
  settings: Record<string, string>;
  images: ImageResult[];
  summary: {
    lossless: Record<string, { bytes: number; images: number; exactAll: boolean }>;
    lossy: Record<string, { bytes: number; images: number; smgBytesSameSet: number; deltaPercent: number }>;
  };
}

export const bench = report as unknown as Report;

/** Percent difference of SMG relative to `codec` (negative = SMG smaller). */
export function losslessDelta(codec: string, filter?: (im: ImageResult) => boolean): number {
  let smg = 0, other = 0;
  for (const im of bench.images) {
    if (filter && !filter(im)) continue;
    if (!im.lossless[codec]) continue;
    smg += im.lossless.smg.bytes;
    other += im.lossless[codec].bytes;
  }
  return other ? ((smg - other) / other) * 100 : 0;
}

export function lossyDelta(codec: string, filter?: (im: ImageResult) => boolean): { delta: number; images: number } {
  let smg = 0, other = 0, n = 0;
  for (const im of bench.images) {
    if (filter && !filter(im)) continue;
    const r = im.lossy.results[codec];
    if (!r || !r.bytes || r.reachedTarget === false) continue;
    smg += im.lossy.results.smg.bytes;
    other += r.bytes;
    n++;
  }
  return { delta: other ? ((smg - other) / other) * 100 : 0, images: n };
}

export const fmtPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;

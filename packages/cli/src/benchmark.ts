/**
 * Reproducible compression benchmark: SMG vs PNG / JPEG / WebP / AVIF.
 *
 * Lossless: every codec encodes the same RGBA pixels at its strongest
 * practical setting; outputs are decoded again and compared pixel by pixel.
 *
 * Lossy ("equal quality"): SMG encodes at quality Q (auto mode). Its SSIM
 * becomes the target; for each other codec a binary search finds the smallest
 * output whose SSIM reaches that target. Reported sizes are therefore "bytes
 * needed for the same measured quality".
 *
 * Reference encoders come from sharp/libvips (libpng, mozjpeg, libwebp,
 * libheif+aom). Timings are wall-clock on one thread (sharp.concurrency(1)).
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { decode, encode, pixelsEqual, psnr, ssim, SMG_CODEC_VERSION, type RgbaImage } from '@smg/codec';
import { loadSharp } from './image-io.ts';

type Img = RgbaImage & { data: Uint8Array };

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

export interface BenchmarkReport {
  tool: string;
  generatedAt: string;
  machine: { cpu: string; cores: number; memoryGB: number; os: string; node: string };
  versions: Record<string, string>;
  settings: Record<string, unknown>;
  images: ImageResult[];
  summary: {
    lossless: Record<string, { bytes: number; images: number; exactAll: boolean }>;
    lossy: Record<string, { bytes: number; images: number; smgBytesSameSet: number; deltaPercent: number }>;
  };
}

function now(): number {
  return performance.now();
}

function hasAlpha(img: RgbaImage): boolean {
  for (let p = 3; p < img.data.length; p += 4) if (img.data[p] !== 255) return true;
  return false;
}

export interface BenchmarkOptions {
  quality: number;
  formats: string[];
  onLog?: (s: string) => void;
}

export async function benchmarkImages(files: Array<{ file: string; category: string; image: Img; sourceBytes: number }>, opts: BenchmarkOptions): Promise<BenchmarkReport> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error('smg benchmark needs the optional "sharp" package for reference encoders (npm install sharp)');
  sharp.concurrency(1);
  sharp.cache(false);
  const log = opts.onLog ?? (() => {});
  const fmts = new Set(opts.formats);
  const images: ImageResult[] = [];

  const raw = (img: Img) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } });
  const sharpDecode = async (buf: Buffer): Promise<{ img: Img; ms: number }> => {
    const t = now();
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { img: { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }, ms: now() - t };
  };
  const timed = async (fn: () => Promise<Buffer>): Promise<{ buf: Buffer; ms: number }> => {
    const t = now();
    const buf = await fn();
    return { buf, ms: now() - t };
  };

  for (const f of files) {
    const img = f.image;
    const alpha = hasAlpha(img);
    log(`• ${path.basename(f.file)} (${img.width}×${img.height}${alpha ? ', alpha' : ''})`);
    const lossless: Record<string, CodecResult> = {};
    // ---- lossless ----
    {
      const t = now();
      const r = encode(img, { mode: 'lossless', effort: 7 });
      const encMs = now() - t;
      const t2 = now();
      const d = decode(r.bytes);
      const decMs = now() - t2;
      lossless.smg = { bytes: r.bytes.length, encodeMs: encMs, decodeMs: decMs, exact: pixelsEqual(d.image, img), note: r.info.codecName };
    }
    const llSpecs: Array<[string, () => Promise<Buffer>]> = [];
    if (fmts.has('png')) llSpecs.push(['png', () => raw(img).png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer()]);
    if (fmts.has('webp')) llSpecs.push(['webp', () => raw(img).webp({ lossless: true, effort: 6, exact: true }).toBuffer()]);
    if (fmts.has('avif')) llSpecs.push(['avif', () => raw(img).avif({ lossless: true, effort: 4 }).toBuffer()]);
    for (const [name, fn] of llSpecs) {
      const { buf, ms } = await timed(fn);
      const d = await sharpDecode(buf);
      lossless[name] = { bytes: buf.length, encodeMs: ms, decodeMs: d.ms, exact: pixelsEqual(d.img, img) };
    }
    // ---- lossy (equal SSIM) ----
    const results: Record<string, CodecResult> = {};
    const t = now();
    const smg = encode(img, { mode: 'auto', quality: opts.quality });
    const encMs = now() - t;
    const t2 = now();
    const smgDec = decode(smg.bytes).image;
    const decMs = now() - t2;
    const smgSsim = ssim(img, smgDec);
    const targetSsim = Math.min(smgSsim, 0.995);
    results.smg = { bytes: smg.bytes.length, encodeMs: encMs, decodeMs: decMs, quality: smg.info.quality, psnr: psnr(img, smgDec), ssim: smgSsim, exact: smg.info.exact, reachedTarget: true, note: smg.info.codecName };
    const lossySpecs: Array<[string, (q: number) => Promise<Buffer>, boolean]> = [];
    if (fmts.has('jpeg')) lossySpecs.push(['jpeg', (q) => raw(img).removeAlpha().jpeg({ quality: q, mozjpeg: true }).toBuffer(), !alpha]);
    if (fmts.has('webp')) lossySpecs.push(['webp', (q) => raw(img).webp({ quality: q, effort: 6 }).toBuffer(), true]);
    if (fmts.has('avif')) lossySpecs.push(['avif', (q) => raw(img).avif({ quality: q, effort: 4 }).toBuffer(), true]);
    for (const [name, fn, supported] of lossySpecs) {
      if (!supported) {
        results[name] = { bytes: 0, encodeMs: 0, decodeMs: 0, note: 'no alpha support — skipped' };
        continue;
      }
      // Binary search the smallest quality whose SSIM >= target.
      let lo = 1, hi = 100;
      let best: { q: number; buf: Buffer; ms: number; s: number; p: number; dms: number } | null = null;
      const evalQ = async (q: number) => {
        const { buf, ms } = await timed(() => fn(q));
        const d = await sharpDecode(buf);
        return { q, buf, ms, s: ssim(img, d.img), p: psnr(img, d.img), dms: d.ms };
      };
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = await evalQ(mid);
        if (r.s >= targetSsim) {
          best = r;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      let reached = true;
      if (!best) {
        best = await evalQ(100);
        reached = false;
      }
      results[name] = { bytes: best.buf.length, encodeMs: best.ms, decodeMs: best.dms, quality: best.q, psnr: best.p, ssim: best.s, reachedTarget: reached };
    }
    images.push({
      file: path.basename(f.file),
      category: f.category,
      width: img.width,
      height: img.height,
      hasAlpha: alpha,
      sourceBytes: f.sourceBytes,
      lossless,
      lossy: { targetSsim, smgQuality: opts.quality, results },
    });
    const ll = Object.entries(lossless).map(([k, v]) => `${k} ${v.bytes}${v.exact ? '' : '≠'}`).join('  ');
    const ly = Object.entries(results).map(([k, v]) => (v.bytes ? `${k} ${v.bytes}${v.reachedTarget === false ? '*' : ''}` : `${k} —`)).join('  ');
    log(`    lossless: ${ll}`);
    log(`    equal-SSIM (${targetSsim.toFixed(4)}): ${ly}`);
  }

  // ---- summary ----
  const summary: BenchmarkReport['summary'] = { lossless: {}, lossy: {} };
  for (const im of images) {
    for (const [k, v] of Object.entries(im.lossless)) {
      const s = (summary.lossless[k] ??= { bytes: 0, images: 0, exactAll: true });
      s.bytes += v.bytes;
      s.images++;
      if (!v.exact) s.exactAll = false;
    }
  }
  for (const codec of ['jpeg', 'webp', 'avif']) {
    let bytes = 0, smgBytes = 0, n = 0;
    for (const im of images) {
      const r = im.lossy.results[codec];
      if (!r || !r.bytes || r.reachedTarget === false) continue;
      bytes += r.bytes;
      smgBytes += im.lossy.results.smg.bytes;
      n++;
    }
    if (n) summary.lossy[codec] = { bytes, images: n, smgBytesSameSet: smgBytes, deltaPercent: ((smgBytes - bytes) / bytes) * 100 };
  }
  return {
    tool: `smg benchmark (SMG ${SMG_CODEC_VERSION})`,
    generatedAt: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 1e9),
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      node: process.version,
    },
    versions: { smg: SMG_CODEC_VERSION, ...sharp.versions },
    settings: {
      smgLossless: "mode 'lossless', effort 7",
      smgLossy: `mode 'auto', quality ${opts.quality}, effort 5`,
      png: 'libpng via sharp: compressionLevel 9, adaptiveFiltering',
      webpLossless: 'libwebp via sharp: lossless, effort 6, exact',
      avifLossless: 'libheif/aom via sharp: lossless, effort 4',
      jpeg: 'mozjpeg via sharp, quality searched 1–100',
      webpLossy: 'libwebp via sharp, effort 6, quality searched 1–100',
      avifLossy: 'libheif/aom via sharp, effort 4, quality searched 1–100',
      ssim: 'luma SSIM, Gaussian σ=1.5, alpha-premultiplied; lossy target = min(SMG SSIM, 0.995)',
      threads: 'sharp.concurrency(1); SMG is single-threaded JavaScript',
    },
    images,
    summary,
  };
}

export function reportToMarkdown(r: BenchmarkReport): string {
  const kb = (b: number) => (b ? (b / 1000).toFixed(1) : '—');
  const lines: string[] = [];
  lines.push(`# SMG benchmark results`, '');
  lines.push(`Generated ${r.generatedAt} by \`${r.tool}\`.`, '');
  lines.push(`**Machine:** ${r.machine.cpu} · ${r.machine.cores} cores · ${r.machine.memoryGB} GB · ${r.machine.os} · Node ${r.machine.node}`, '');
  lines.push(`**Reference libraries:** libvips ${r.versions.vips}, libpng ${r.versions.png}, mozjpeg ${r.versions.mozjpeg}, libwebp ${r.versions.webp}, libheif ${r.versions.heif}, aom ${r.versions.aom} (sharp ${r.versions.sharp}).`, '');
  lines.push('## Lossless (KB, smaller is better; ≠ = not bit-exact)', '');
  const llCodecs = Object.keys(r.images[0]?.lossless ?? {});
  lines.push(`| Image | Size | ${llCodecs.map((c) => c.toUpperCase()).join(' | ')} |`);
  lines.push(`|---|---|${llCodecs.map(() => '---:').join('|')}|`);
  for (const im of r.images) {
    lines.push(`| ${im.file} | ${im.width}×${im.height} | ${llCodecs.map((c) => `${kb(im.lossless[c].bytes)}${im.lossless[c].exact ? '' : ' ≠'}`).join(' | ')} |`);
  }
  lines.push(`| **Total** | | ${llCodecs.map((c) => `**${kb(r.summary.lossless[c].bytes)}**`).join(' | ')} |`, '');
  lines.push(`## Lossy at equal SSIM (KB; SMG quality ${r.images[0]?.lossy.smgQuality}; * = target not reached at quality 100)`, '');
  const lyCodecs = Object.keys(r.images[0]?.lossy.results ?? {});
  lines.push(`| Image | Target SSIM | ${lyCodecs.map((c) => c.toUpperCase()).join(' | ')} |`);
  lines.push(`|---|---:|${lyCodecs.map(() => '---:').join('|')}|`);
  for (const im of r.images) {
    lines.push(`| ${im.file} | ${im.lossy.targetSsim.toFixed(4)} | ${lyCodecs.map((c) => { const x = im.lossy.results[c]; return x.bytes ? `${kb(x.bytes)}${x.reachedTarget === false ? '*' : ''}` : '—'; }).join(' | ')} |`);
  }
  lines.push('');
  for (const [c, s] of Object.entries(r.summary.lossy)) {
    lines.push(`- vs ${c.toUpperCase()} (${s.images} images where ${c.toUpperCase()} reached the target): SMG ${kb(s.smgBytesSameSet)} KB vs ${kb(s.bytes)} KB → ${s.deltaPercent >= 0 ? '+' : ''}${s.deltaPercent.toFixed(1)}%`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeReport(r: BenchmarkReport, out: string): void {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  fs.writeFileSync(out.replace(/\.json$/, '') + '.md', reportToMarkdown(r));
}

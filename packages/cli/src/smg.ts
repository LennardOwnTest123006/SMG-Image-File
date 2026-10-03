/**
 * smg — command-line tool for the SMG image format.
 *
 *   smg encode input.png [output.smg] [options]
 *   smg decode input.smg [output.png]
 *   smg info image.smg
 *   smg benchmark input.png [more…] | --corpus dir
 *   smg compare a.png b.smg
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  compressionStats,
  decode,
  describeStats,
  encode,
  formatBytes,
  inspect,
  isSmgError,
  pixelHash,
  PRESETS,
  psnr,
  ssim,
  SMG_CODEC_VERSION,
  type EncodeOptions,
  type SmgMode,
  type SmgPreset,
} from '@smg/codec';
import { resizeImage } from '@smg/codec/io';
import { benchmarkImages, reportToMarkdown, writeReport } from './benchmark.ts';
import { encodeConventional, formatFromPath, readImageFile, type OutputFormat } from './image-io.ts';

const VERSION = SMG_CODEC_VERSION;

const HELP = `smg ${VERSION} — the SMG image format command-line tool

Usage:
  smg encode <input…> [-o <output>] [options]   Convert images to .smg
  smg decode <input.smg…> [-o <output>] [--format png|bmp|jpeg|webp|avif] [-q N]
  smg info <file.smg…> [--json]                  Show header, codec and metadata
  smg benchmark <input…> | --corpus <dir> [--quality N] [--out results.json] [--formats png,jpeg,webp,avif]
  smg compare <a> <b>                            PSNR / SSIM / pixel equality

Encode options:
  -p, --preset <name>      auto | photo | screenshot | logo | illustration | ui | smallest | archive
  -m, --mode <mode>        auto | lossless | lossy | palette
  -q, --quality <1-100>    lossy quality (default 80)
  -e, --effort <1-9>       compression effort (default 5)
  -t, --target-size <size> target file size, e.g. 50KB, 1.2MB, 20000
      --colors <2-256>     palette mode: maximum colours
      --dither             palette mode: Floyd–Steinberg dithering
      --strip              remove metadata (text, ICC, EXIF, XMP)
      --normalize-transparent  allow changing RGB under alpha = 0 (visually lossless)
      --resize <WxH>       resize before encoding (e.g. 1920x, x1080, 800x600)
      --frames all         GIF: encode every frame (output-<n>.smg)
      --frame <n>          GIF: encode frame n (default 0)
      --width/--height <n> SVG: rasterisation size
  -o, --output <path>      output file, or a directory for multiple inputs
  -f, --force              overwrite existing files
      --json               machine-readable output

Exit codes: 0 success, 1 usage error, 2 processing error.
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = { p: 'preset', m: 'mode', q: 'quality', e: 'effort', t: 'target-size', o: 'output', f: 'force', h: 'help', v: 'version' };
const BOOLEAN = new Set(['dither', 'strip', 'normalize-transparent', 'force', 'json', 'help', 'version', 'md']);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a))) {
      let key = a.replace(/^--?/, '');
      let val: string | boolean | undefined;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = ALIASES[key] ?? key;
      if (val === undefined) {
        if (BOOLEAN.has(key)) val = true;
        else {
          val = argv[++i];
          if (val === undefined) throw new UsageError(`missing value for --${key}`);
        }
      }
      out.flags[key] = val;
    } else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

export function parseSize(s: string): number {
  const m = /^\s*([\d.]+)\s*(b|kb|k|kib|mb|m|mib)?\s*$/i.exec(s);
  if (!m) throw new UsageError(`invalid size "${s}"`);
  const v = parseFloat(m[1]);
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = unit === 'kb' || unit === 'k' ? 1000 : unit === 'kib' ? 1024 : unit === 'mb' || unit === 'm' ? 1e6 : unit === 'mib' ? 1048576 : 1;
  return Math.round(v * mult);
}

function num(flags: Args['flags'], key: string, min: number, max: number): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${key} must be a number between ${min} and ${max}`);
  return n;
}

function outPathFor(input: string, output: string | undefined, ext: string, multiple: boolean, suffix = ''): string {
  const base = path.basename(input).replace(/\.[^.]+$/, '') + suffix + ext;
  if (!output) return path.join(path.dirname(input), base);
  if (multiple || (fs.existsSync(output) && fs.statSync(output).isDirectory()) || output.endsWith('/')) {
    fs.mkdirSync(output, { recursive: true });
    return path.join(output, base);
  }
  return output;
}

function writeOut(file: string, data: Uint8Array, force: boolean): void {
  if (fs.existsSync(file) && !force) throw new UsageError(`${file} already exists (use --force to overwrite)`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, data);
}

async function cmdEncode(a: Args): Promise<void> {
  if (a._.length === 0) throw new UsageError('encode: no input files');
  const f = a.flags;
  const preset = f.preset as SmgPreset | undefined;
  if (preset && !(preset in PRESETS)) throw new UsageError(`unknown preset "${preset}"`);
  const mode = f.mode as SmgMode | undefined;
  if (mode && !['auto', 'lossless', 'lossy', 'palette'].includes(mode)) throw new UsageError(`unknown mode "${mode}"`);
  const opts: EncodeOptions = {
    preset,
    mode,
    quality: num(f, 'quality', 1, 100),
    effort: num(f, 'effort', 1, 9),
    targetSize: f['target-size'] ? parseSize(String(f['target-size'])) : undefined,
    maxColors: num(f, 'colors', 2, 256),
    dither: Boolean(f.dither),
    stripMetadata: Boolean(f.strip),
    exactTransparent: !f['normalize-transparent'],
  };
  const multiple = a._.length > 1;
  const results: unknown[] = [];
  const seen = new Map<string, { out: string; bytes: Uint8Array; info: ReturnType<typeof encode>['info'] }>();
  const usedOutputs = new Set<string>();
  let failures = 0;
  for (const input of a._) {
    try {
      const loaded = await readImageFile(input, { frame: num(f, 'frame', 0, 1e6), width: num(f, 'width', 1, 65535), height: num(f, 'height', 1, 65535) });
      const frames = f.frames === 'all' && loaded.frames ? loaded.frames : [loaded.image];
      if (frames.length > 1) loaded.notes = loaded.notes.filter((n) => !n.startsWith('GIF has'));
      let framesTotal = 0;
      for (let fi = 0; fi < frames.length; fi++) {
        let img = frames[fi];
        if (f.resize) {
          const m = /^(\d*)x(\d*)$/i.exec(String(f.resize));
          if (!m || (!m[1] && !m[2])) throw new UsageError('--resize expects WxH, Wx or xH');
          const w = m[1] ? Number(m[1]) : Math.round((Number(m[2]) * img.width) / img.height);
          const h = m[2] ? Number(m[2]) : Math.round((Number(m[1]) * img.height) / img.width);
          img = resizeImage(img, w, h);
        }
        const hash = pixelHash(img);
        const dupEntry = seen.get(hash);
        const dup = dupEntry?.out;
        let out = outPathFor(input, f.output as string | undefined, '.smg', multiple || frames.length > 1, frames.length > 1 ? `-${String(fi).padStart(3, '0')}` : '');
        for (let k = 2; usedOutputs.has(out); k++) out = out.replace(/(-\d+)?\.smg$/, `-${k}.smg`);
        usedOutputs.add(out);
        const t0 = performance.now();
        // Duplicate detection: identical pixels are encoded once and reused.
        const r = dupEntry && !loaded.metadata.icc && !loaded.metadata.exif ? { bytes: dupEntry.bytes, info: dupEntry.info } : encode(img, { ...opts, metadata: loaded.metadata });
        const ms = performance.now() - t0;
        if (!dupEntry) seen.set(hash, { out, bytes: r.bytes, info: r.info });
        if (fs.existsSync(out) && !f.force) throw new Error(`${out} already exists (use --force to overwrite)`);
        writeOut(out, r.bytes, true);
        const srcBytes = fs.statSync(input).size;
        framesTotal += r.bytes.length;
        const stats = compressionStats(srcBytes, r.bytes.length, img.width * img.height);
        if (f.json) {
          results.push({ input, output: out, ...r.info, sourceBytes: srcBytes, stats, duplicateOf: dup ?? null, notes: loaded.notes });
        } else {
          console.log(`${input}${frames.length > 1 ? ` [frame ${fi}]` : ''} → ${out}`);
          console.log(`  ${img.width}×${img.height} · ${r.info.codecName} · ${r.info.colorModelName}${r.info.quality !== null ? ` · quality ${r.info.quality}` : ''} · ${r.info.exact ? 'lossless (bit-exact)' : r.info.visuallyLossless ? 'visually lossless' : 'lossy'}`);
          if (frames.length > 1) console.log(`  SMG: ${formatBytes(r.bytes.length)} (${stats.bitsPerPixel!.toFixed(2)} bpp, ${ms.toFixed(0)} ms)`);
          else console.log(`  ${describeStats(stats)} (${stats.bitsPerPixel!.toFixed(2)} bpp, ${ms.toFixed(0)} ms)`);
          if (r.info.candidates.length > 1) console.log(`  candidates: ${r.info.candidates.map((c) => `${c.label} ${formatBytes(c.bytes)}${c.chosen ? ' ✓' : ''}`).join(' · ')}`);
          if (r.info.targetSize !== null) console.log(`  target ${formatBytes(r.info.targetSize)}: ${r.info.targetMet ? 'met' : 'NOT met — smallest achievable output written'}`);
          if (dup) console.log(`  note: identical pixels to ${dup} — encoded once and reused`);
          if (fi === frames.length - 1) for (const n of loaded.notes) console.log(`  note: ${n}`);
        }
      }
      if (frames.length > 1 && !f.json) console.log(`  all ${frames.length} frames: ${describeStats(compressionStats(fs.statSync(input).size, framesTotal), 'SMG frames')}`);
    } catch (e) {
      failures++;
      if (e instanceof UsageError) throw e;
      console.error(`${input}: ${(e as Error).message}`);
    }
  }
  if (f.json) console.log(JSON.stringify(multiple || results.length > 1 ? results : results[0], null, 2));
  if (failures) process.exitCode = 2;
}

async function cmdDecode(a: Args): Promise<void> {
  if (a._.length === 0) throw new UsageError('decode: no input files');
  const f = a.flags;
  const multiple = a._.length > 1;
  for (const input of a._) {
    const bytes = new Uint8Array(fs.readFileSync(input));
    const { image, info } = decode(bytes);
    let fmt = (f.format as OutputFormat | undefined) ?? (f.output && !multiple ? (formatFromPath(String(f.output)) as OutputFormat | null) : null) ?? 'png';
    if ((fmt as string) === 'jpg') fmt = 'jpeg';
    if (!['png', 'bmp', 'jpeg', 'webp', 'avif'].includes(fmt)) throw new UsageError(`unsupported output format "${fmt}"`);
    const ext = fmt === 'jpeg' ? '.jpg' : `.${fmt}`;
    const out = outPathFor(input, f.output as string | undefined, ext, multiple);
    const data = await encodeConventional(image, fmt, num(f, 'quality', 1, 100) ?? 90, f.strip ? undefined : info.metadata);
    writeOut(out, data, Boolean(f.force));
    if (f.json) console.log(JSON.stringify({ input, output: out, width: image.width, height: image.height, format: fmt, bytes: data.length }));
    else console.log(`${input} → ${out} (${image.width}×${image.height}, ${fmt.toUpperCase()}, ${formatBytes(data.length)})`);
  }
}

function cmdInfo(a: Args): void {
  if (a._.length === 0) throw new UsageError('info: no input files');
  for (const input of a._) {
    const bytes = new Uint8Array(fs.readFileSync(input));
    const info = inspect(bytes);
    if (a.flags.json) {
      const md = { ...info.metadata, icc: info.metadata.icc ? `${info.metadata.icc.length} bytes` : undefined, exif: info.metadata.exif ? `${info.metadata.exif.length} bytes` : undefined };
      console.log(JSON.stringify({ file: input, ...info, metadata: md }, null, 2));
      continue;
    }
    const raw = info.width * info.height * 4;
    console.log(`${input}`);
    console.log(`  Format       SMG ${info.versionMajor}.${info.versionMinor}`);
    console.log(`  Dimensions   ${info.width} × ${info.height} (${(info.width * info.height / 1e6).toFixed(2)} MP)`);
    console.log(`  Colour       ${info.colorModelName}, ${info.bitDepth}-bit`);
    console.log(`  Codec        ${info.codecName}`);
    console.log(`  Fidelity     ${info.exact ? 'lossless (bit-exact)' : info.visuallyLossless ? 'visually lossless' : info.quantized ? 'lossy (palette quantised)' : 'lossy'}${info.quality !== null ? `, quality ${info.quality}` : ''}`);
    console.log(`  File size    ${formatBytes(info.fileBytes)} (${info.fileBytes} bytes, ${((info.fileBytes * 8) / (info.width * info.height)).toFixed(3)} bpp, ${(raw / info.fileBytes).toFixed(1)}:1 vs raw RGBA)`);
    console.log(`  Checksum     ${info.checksum !== null ? `CRC-32 ${info.checksum.toString(16).padStart(8, '0')}` : 'none'}`);
    const md = info.metadata;
    if (md.text) for (const [k, v] of Object.entries(md.text)) console.log(`  ${k.padEnd(12)} ${v}`);
    if (md.icc) console.log(`  ICC profile  ${md.icc.length} bytes`);
    if (md.exif) console.log(`  EXIF         ${md.exif.length} bytes`);
    if (md.xmp) console.log(`  XMP          ${md.xmp.length} characters`);
    console.log(`  Chunks       ${info.chunks.map((c) => `${c.tag}(${c.length})`).join(' ')}`);
  }
}

async function cmdCompare(a: Args): Promise<void> {
  if (a._.length !== 2) throw new UsageError('compare: expected two images');
  const [x, y] = await Promise.all(a._.map((p) => readImageFile(p)));
  if (x.image.width !== y.image.width || x.image.height !== y.image.height) throw new UsageError('images have different dimensions');
  const p = psnr(x.image, y.image);
  const s = ssim(x.image, y.image);
  const eq = p === Infinity;
  if (a.flags.json) console.log(JSON.stringify({ identical: eq, psnr: eq ? null : p, ssim: s }));
  else console.log(eq ? 'Pixels are identical.' : `PSNR ${p.toFixed(2)} dB · SSIM ${s.toFixed(5)}`);
}

async function cmdBenchmark(a: Args): Promise<void> {
  const f = a.flags;
  const items: Array<{ file: string; category: string; image: any; sourceBytes: number }> = [];
  const add = async (file: string, category: string) => {
    const l = await readImageFile(file);
    items.push({ file, category, image: l.image, sourceBytes: fs.statSync(file).size });
  };
  if (f.corpus) {
    const dir = String(f.corpus);
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      for (const m of JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) await add(path.join(dir, m.file), m.category);
    } else {
      for (const file of fs.readdirSync(dir).filter((x) => /\.(png|jpe?g|bmp|gif|webp)$/i.test(x)).sort()) await add(path.join(dir, file), 'other');
    }
  }
  for (const file of a._) await add(file, 'other');
  if (!items.length) throw new UsageError('benchmark: no input images (pass files or --corpus <dir>)');
  const report = await benchmarkImages(items, {
    quality: num(f, 'quality', 1, 100) ?? 80,
    formats: String(f.formats ?? 'png,jpeg,webp,avif').split(',').map((s) => s.trim().toLowerCase()),
    onLog: f.json ? undefined : (s) => console.log(s),
  });
  if (f.out) {
    writeReport(report, String(f.out));
    if (!f.json) console.log(`\nWrote ${f.out} and ${String(f.out).replace(/\.json$/, '')}.md`);
  }
  if (f.json) console.log(JSON.stringify(report, null, 2));
  else console.log('\n' + reportToMarkdown(report));
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`smg: ${(e as Error).message}\n`);
    return 1;
  }
  const [cmd, ...rest] = args._;
  args._ = rest;
  if (args.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || args.flags.help || cmd === 'help') {
    console.log(HELP);
    return cmd || args.flags.help ? 0 : 1;
  }
  try {
    switch (cmd) {
      case 'encode':
        await cmdEncode(args);
        break;
      case 'decode':
        await cmdDecode(args);
        break;
      case 'info':
        cmdInfo(args);
        break;
      case 'benchmark':
      case 'bench':
        await cmdBenchmark(args);
        break;
      case 'compare':
        await cmdCompare(args);
        break;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`smg: ${e.message}\nRun "smg --help" for usage.`);
      return 1;
    }
    console.error(`smg: ${isSmgError(e) ? e.message : (e as Error).stack ?? String(e)}`);
    return 2;
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

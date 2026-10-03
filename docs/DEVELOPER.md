# SMG developer guide

SMG ships as three pieces that share one codec implementation:

| Package | What it is |
|---------|------------|
| `@smg/codec` | The reference encoder/decoder (TypeScript, zero runtime dependencies, ~52 KB minified). Runs in browsers, Web Workers, Node.js, Deno and Bun. |
| `@smg/codec/io` | Helpers around the codec: exact PNG/BMP/GIF readers and writers, format sniffing, JPEG metadata, resizing, ZIP writer. Uses `fflate` for PNG deflate. |
| `@smg/cli` | The `smg` command-line tool (`encode`, `decode`, `info`, `benchmark`, `compare`). |

The binary format itself is specified in [the SMG specification](/format).

## Quick start (JavaScript / TypeScript)

```ts
import { encode, decode, inspect } from '@smg/codec';

// Any 8-bit RGBA buffer works — e.g. canvas ImageData.
const ctx = canvas.getContext('2d')!;
const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

const { bytes, info } = encode(imageData, { preset: 'photo' });
console.log(info.codecName, info.outputBytes, info.exact);

const { image } = decode(bytes);            // { width, height, data: Uint8Array (RGBA) }
ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer), image.width, image.height), 0, 0);

const meta = inspect(bytes);                // header, chunks, metadata — no pixel decoding
```

### Node.js: PNG → SMG → PNG

```ts
import fs from 'node:fs';
import { encode, decode, pixelsEqual } from '@smg/codec';
import { decodePng, encodePng } from '@smg/codec/io';

const png = decodePng(fs.readFileSync('input.png'));
const { bytes, info } = encode(png.image, { mode: 'lossless', metadata: { icc: png.icc, text: png.text } });
fs.writeFileSync('output.smg', bytes);

const { image } = decode(fs.readFileSync('output.smg'));
console.log('bit-exact:', pixelsEqual(image, png.image)); // true
fs.writeFileSync('roundtrip.png', encodePng(image));
```

### In a Web Worker

Encoding large images takes time, so run it off the main thread:

```ts
// worker.ts
import { encode } from '@smg/codec';
self.onmessage = (e) => {
  const { width, height, buffer, options } = e.data;
  const { bytes, info } = encode({ width, height, data: new Uint8Array(buffer) }, {
    ...options,
    onProgress: (p, stage) => self.postMessage({ type: 'progress', p, stage }),
  });
  self.postMessage({ type: 'done', bytes, info }, [bytes.buffer]);
};
```

Cancellation: pass `signal: { aborted: boolean }` and set `aborted = true` (checked between encoder stages), or terminate the worker for an immediate stop. The SMG website uses a small worker pool with both mechanisms.

## API reference

### `encode(image, options?) → { bytes, info }`

`image` is `{ width, height, data }` where `data` is a `Uint8Array` or `Uint8ClampedArray` of `width × height × 4` RGBA bytes (not premultiplied).

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `preset` | `'auto' \| 'photo' \| 'screenshot' \| 'logo' \| 'illustration' \| 'ui' \| 'smallest' \| 'archive'` | — | Fills mode / quality / effort defaults. |
| `mode` | `'auto' \| 'lossless' \| 'lossy' \| 'palette'` | `'auto'` | Codec family (see below). |
| `quality` | 1–100 | 80 | Lossy quality (wavelet quantiser step). |
| `effort` | 1–9 | 5 | More candidates and deeper search at higher effort. |
| `targetSize` | bytes | — | Finds the highest quality whose file fits. Reported via `info.targetMet`. |
| `maxColors` | 2–256 | 256 | Palette mode colour limit. |
| `dither` | boolean | false | Floyd–Steinberg dithering for palette quantisation. |
| `exactTransparent` | boolean | true | When false, RGB under alpha = 0 may be normalised (visually lossless, not bit-exact). |
| `metadata` | `{ text?, icc?, exif?, xmp? }` | — | Stored in ancillary chunks. |
| `stripMetadata` | boolean | false | Drop all metadata. |
| `checksum` | boolean | true | Store a CRC-32 of the decoded pixels for exact encodes. |
| `onProgress` | `(fraction, stage) => void` | — | Progress callback. |
| `signal` | `{ aborted: boolean }` | — | Cooperative cancellation (`SMG_E_ABORTED`). |

**Modes**

- `lossless` — tries SMG-L (with LZ copies for graphics) and, for ≤ 256 colours, SMG-P; keeps the smallest. Always bit-exact.
- `lossy` — SMG-W wavelet at `quality`. For graphic-like images it also tries exact candidates and keeps them when smaller.
- `palette` — exact palette when the image has ≤ `maxColors` colours, otherwise colour quantisation.
- `auto` — smallest candidate that meets the quality bar set by SMG-W at `quality`: exact candidates always qualify; a quantised palette qualifies only if its PSNR is at least the wavelet's.

**`info` (EncodeInfo)** includes `codec`, `codecName`, `colorModel`, `exact`, `visuallyLossless`, `quality`, `rawBytes`, `outputBytes`, `metadataBytes`, `candidates[]` (label, bytes, exact, quality, timeMs, chosen), `targetSize`, `targetMet`, `analysis` (content statistics) and `timeMs`.

### `decode(bytes, options?) → { image, info }`

| Option | Default | Meaning |
|--------|---------|---------|
| `maxPixels` | 100 000 000 | Reject larger images before allocating (`SMG_E_LIMIT`). |
| `maxDimension` | 32768 | Maximum width or height. |
| `verifyChecksum` | true | Verify the stored pixel CRC (`SMG_E_CHECKSUM`). |

`image.data` is always RGBA8. `info` (SmgInfo) contains version, dimensions, colour model, codec, flags (`exact`, `quantized`, `visuallyLossless`), quality, sizes, metadata, checksum and the chunk list.

### `inspect(bytes, limits?) → SmgInfo`

Validates the container (signature, version, CRCs, chunk order, limits) and parses metadata without decoding pixels.

### Utilities

| Function | Purpose |
|----------|---------|
| `isSmg(bytes)` | Signature check. |
| `analyzeImage(image)` | Alpha usage, grayscale, unique colours, gradient statistics, content class. |
| `psnr(a, b)`, `ssim(a, b)` | Quality metrics (alpha-premultiplied when transparency is present). |
| `pixelsEqual(a, b)`, `pixelHash(image)` | Exactness checks and duplicate detection. |
| `compressionStats(orig, compressed, pixels?)`, `describeStats(stats)`, `formatBytes(n)` | Reporting (“Original: 1.2 MB · SMG: 180 KB · Space saved: 85%”). |
| `quantizeImage(image, { maxColors, dither })` | Palette quantisation. |
| `stepForQuality(q)`, `qualityForStep(s)` | Quality ↔ quantiser mapping. |

### `@smg/codec/io`

`decodePng`, `encodePng`, `decodeBmp`, `encodeBmp`, `decodeGif` (all frames, composed), `detectFormat`, `readJpegMetadata`, `exifOrientation`, `applyOrientation`, `resizeImage` (Lanczos-3, premultiplied), `cropImage`, `flipImage`, `rotateImage90`, `createZip`.

## Errors

All failures throw `SmgError` with a stable `code`:

```ts
import { decode, isSmgError, SmgErrorCode } from '@smg/codec';
try {
  decode(bytes);
} catch (e) {
  if (isSmgError(e) && e.code === SmgErrorCode.TRUNCATED) console.warn('Incomplete download?');
  else throw e;
}
```

| Code | When |
|------|------|
| `SMG_E_SIGNATURE` | not an SMG file |
| `SMG_E_VERSION` | unsupported major version |
| `SMG_E_TRUNCATED` | file or stream ended early |
| `SMG_E_CRC` | chunk checksum mismatch |
| `SMG_E_CHUNK_ORDER` | invalid chunk structure |
| `SMG_E_UNKNOWN_CRITICAL` | unknown critical chunk |
| `SMG_E_HEADER` | invalid header field |
| `SMG_E_LIMIT` | image larger than the configured limits |
| `SMG_E_CORRUPT` | internally inconsistent payload |
| `SMG_E_CODEC` | unsupported codec id |
| `SMG_E_CHECKSUM` | decoded pixels do not match the stored checksum |
| `SMG_E_ARGUMENT` | invalid API argument |
| `SMG_E_ABORTED` | cancelled |
| `SMG_E_INPUT` | another image format could not be parsed (io helpers, CLI) |

## Command-line tool

```bash
npm install
npm run build -w @smg/codec && npm run build -w @smg/cli
node packages/cli/dist/smg.mjs --help
# or download the single-file build from the website: node smg-1.0.0.mjs --help
```

`smg encode <input…> [-o <output>] [options]`

```bash
smg encode photo.jpg                       # → photo.smg (auto mode, quality 80)
smg encode photo.jpg -q 70 -o small.smg
smg encode screenshot.png --preset screenshot
smg encode logo.png --preset logo --colors 64 --dither
smg encode big.png --target-size 150KB
smg encode *.png -o out/                   # batch; duplicates are encoded once
smg encode anim.gif --frames all           # anim-000.smg, anim-001.smg, …
smg encode icon.svg --width 512 --height 512   # needs the optional sharp package
smg encode photo.jpg --resize 1920x --strip --json
```

`smg decode <input.smg…> [-o out.png] [--format png|bmp|jpeg|webp|avif] [-q N]` — WebP/AVIF output needs `sharp`.

`smg info <file.smg…> [--json]` — header, codec, fidelity, size, checksum, metadata and chunk list.

`smg benchmark <input…> | --corpus <dir> [--quality 80] [--formats png,jpeg,webp,avif] [--out results.json]` — needs `sharp` for the reference encoders; writes JSON and Markdown.

`smg compare <a> <b>` — PSNR, SSIM, or “Pixels are identical.”

Exit codes: `0` success, `1` usage error, `2` processing error.

## Studio project files (`.smgp`)

SMG Studio saves editable projects as JSON (`format: "smg-studio-project"`, `version: 1`). Text and shape layers are stored as properties; pixel layers are stored as **lossless SMG** encoded in base64. Projects are separate from flattened exports (SMG/PNG/JPEG/WebP). Studio also autosaves the same structure to IndexedDB in your browser for recovery.

## Versioning and compatibility

- The file format follows `major.minor` (currently 1.0). Decoders reject other major versions and accept any 1.x minor version, ignoring unknown ancillary chunks.
- The npm packages follow semantic versioning; any change to the bitstream that old decoders cannot read requires a new format major version.
- Encoders are free to improve compression within the specified bitstream (e.g. better predictor selection) without a format change; decoded output for a given file never changes.

## Architecture notes

- **Why TypeScript instead of Rust/WebAssembly?** One implementation runs unchanged in the browser, workers and Node, the bundle stays small, and the code is easy to audit. The trade-off is speed: SMG encodes roughly 1–4 MP/s per core in V8, slower than native C codecs. The hot loops use typed arrays and integer arithmetic so a WebAssembly port remains straightforward.
- **Determinism.** Encoder and decoder share the same context-derivation functions, and all entropy-coder arithmetic is integer-exact, so decoding is reproducible across JavaScript engines.
- **Safety.** Every length, index, distance and sample is range-checked; decoding effort is bounded by the image size; configurable limits apply before allocation.

## Building from source

```bash
npm install
npm test            # Vitest: codec, container, IO, API
npm run build       # codec bundle, CLI bundle, website (apps/web/dist)
npm run test:e2e    # Playwright end-to-end tests against the built site
```

## License

SMG (format specification, codec, CLI and website) is released under the MIT license. See `THIRD_PARTY_LICENSES.md` for bundled dependencies and fonts.

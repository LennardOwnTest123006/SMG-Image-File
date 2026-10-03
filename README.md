<p align="center">
  <img src="apps/web/public/logo.svg" width="88" alt="SMG logo" />
</p>

<h1 align="center">SMG — Images. Smaller. Smarter.</h1>

<p align="center">
An original image format (<code>.smg</code>) with its own lossless, palette and wavelet codecs,<br/>
a zero-dependency TypeScript codec, a command-line tool, and a private in-browser image studio.
</p>

---

## What's in this repository

| Path | Contents |
|------|----------|
| `packages/codec` | **@smg/codec** — reference encoder/decoder: container, range coder, SMG-L (lossless), SMG-P (palette), SMG-W (wavelet lossy), metrics, plus `@smg/codec/io` (PNG/BMP/GIF, format detection, resize, ZIP). |
| `packages/cli` | **smg** CLI — `encode`, `decode`, `info`, `benchmark`, `compare`; bundled to a single file. |
| `apps/web` | The website: landing page, **SMG Studio** editor, converter, compressor, specification, benchmarks, docs, downloads (Vite + React). |
| `docs/` | [`SPEC.md`](docs/SPEC.md) (binary format), [`DEVELOPER.md`](docs/DEVELOPER.md) (API, CLI, errors, versioning), [`DEPLOYMENT.md`](docs/DEPLOYMENT.md). |
| `bench/` | Benchmark corpus, its generator, and the latest [results](bench/results/latest.md). |
| `e2e/` | Playwright end-to-end tests. |

## Highlights

- **A real format, not a renamed one.** Own signature (`89 53 4D 47 0D 0A 1A 0A`), versioned container of CRC-32-protected chunks (critical/ancillary), metadata chunks (ICC, EXIF, XMP, text), optional pixel checksum, strict validation with stable error codes. See the [specification](docs/SPEC.md).
- **Three codecs on one adaptive binary range coder.**
  - **SMG-L** lossless: per-tile choice among 8 predictors (incl. an error-weighted blend), bias cancellation, context-modelled residuals, LZ77 pixel copies and a colour cache for screenshots/graphics.
  - **SMG-P** palette: neighbour-match cascade and transition contexts; optional quantisation (median cut + k-means, dithering).
  - **SMG-W** lossy: CDF 9/7 wavelet, dead-zone quantisation with perceptual weights, block significance + parent/sibling contexts, lossless alpha.
- **Automatic candidate comparison.** Auto mode tries the codecs that fit the content and keeps the smallest result that meets the quality bar; target file size search; presets for photos, screenshots, logos, illustrations, UI assets.
- **SMG Studio.** Layers (opacity, blend modes, visibility, lock, reorder, merge), brush/pencil/eraser/fill/shapes/arrows/text, adjustments & filters with before/after split, crop/resize/rotate/flip, templates and social-media sizes, snapping and grid, undo/redo, keyboard shortcuts, autosave + crash recovery, `.smgp` projects, export to SMG/PNG/JPEG/WebP.
- **Private by design.** All processing happens in the browser (Web Workers). No accounts, uploads, analytics or third-party requests; strict CSP.

## Measured results

From [`bench/results/latest.md`](bench/results/latest.md) — 14 images (photos, screenshots, logos, icons, illustration, gradients), reference encoders via sharp/libvips (libpng, mozjpeg, libwebp, libheif+aom):

| Comparison | Result (negative = SMG smaller) |
|------------|---------------------------------|
| Lossless vs PNG (`compressionLevel 9`), all images | **−38.6 %** |
| Lossless vs WebP lossless (`effort 6, exact`), all images | **−2.7 %** (SMG wins on photos/gradients/icons, WebP on some screenshots and logos) |
| Lossy vs mozjpeg at equal SSIM (9 opaque images) | **−53.5 %** |
| Lossy vs WebP at equal SSIM (14 images) | **−13.4 %** |
| Lossy vs AVIF at equal SSIM (14 images) | **+15.9 %** — AVIF produces smaller files |

The corpus is small, SSIM is one metric among many, and SMG (JavaScript) is slower than native codecs. Run `npm run bench` or the live benchmark on the website to test your own images.

## Quick start

Requirements: Node.js ≥ 20 (22 recommended), npm ≥ 10.

```bash
npm install
npm run build          # codec + CLI bundles, release downloads, website → apps/web/dist
npm run preview -w @smg/web   # serve the production build on http://localhost:4173
npm run dev            # development server with hot reload
```

No environment variables or API keys are required.

### CLI

```bash
node packages/cli/dist/smg.mjs encode photo.jpg -q 80          # photo.smg
node packages/cli/dist/smg.mjs encode screenshot.png --preset screenshot
node packages/cli/dist/smg.mjs encode big.png --target-size 150KB
node packages/cli/dist/smg.mjs decode photo.smg -o photo.png
node packages/cli/dist/smg.mjs info photo.smg
node packages/cli/dist/smg.mjs benchmark input.png              # needs the optional sharp package
```

### Library

```ts
import { encode, decode, inspect } from '@smg/codec';

const { bytes, info } = encode(imageData, { preset: 'photo' });   // RGBA in, .smg bytes out
const { image } = decode(bytes);                                  // RGBA out
console.log(inspect(bytes).codecName, info.outputBytes);
```

Full API, options, error codes and examples: [docs/DEVELOPER.md](docs/DEVELOPER.md).

## Testing

```bash
npm test              # Vitest: 140+ codec, container, IO, API and config tests
npm run typecheck     # TypeScript for codec, CLI and web
npm run test:e2e      # Playwright E2E against the production build (Chromium)
```

If Playwright cannot download browsers in your environment, point it at an existing Chromium: `CHROMIUM_PATH=/path/to/chrome npm run test:e2e`.

## Benchmarks

```bash
npm run build -w @smg/cli
npm run bench:corpus  # optional: regenerate bench/corpus (needs Chromium for screenshots)
npm run bench         # writes bench/results/latest.json and .md
```

The website's `/benchmarks` page renders `bench/results/latest.json` at build time — rebuild the site after re-running the benchmark.

## Deployment

The site is a static SPA configured for Netlify in [`netlify.toml`](netlify.toml) (build command, publish directory, SPA redirect, security headers, caching). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and the [release checklist](RELEASE_CHECKLIST.md).

## Architecture

```
            ┌──────────────── @smg/codec (TypeScript, no deps) ────────────────┐
 RGBA ──▶   │ analyse ─▶ candidates: SMG-L │ SMG-P │ SMG-W ─▶ choose ─▶ container │ ──▶ .smg
            │            range coder + context models (shared)                    │
            └──────────────────────────────────────────────────────────────────────┘
               ▲ used by                 ▲ used by                  ▲ used by
       apps/web (Web Worker pool)    packages/cli (Node)        tests / benchmarks
```

TypeScript was chosen over Rust/WebAssembly so one auditable implementation runs in browsers, workers and Node with a small bundle; the trade-off is speed (documented in the developer guide).

## Version & license

Version **1.0.0** (format 1.0). MIT — see [LICENSE](LICENSE). Third-party components and credits: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

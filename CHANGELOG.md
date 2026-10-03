# Changelog

## 1.0.0 — 2026-10-03

First public release.

### Format
- SMG 1.0 container: signature, version, CRC-32 chunks with critical/ancillary semantics, `HEAD`/`DATA`/`TAIL`, metadata chunks (`prof`, `exif`, `xmpd`, `meta`) and pixel checksum (`csum`).
- Codecs: SMG-L (lossless predictive + LZ77 + colour cache), SMG-P (palette), SMG-W (CDF 9/7 wavelet lossy with lossless alpha).

### @smg/codec
- Encoder with presets, modes (auto/lossless/lossy/palette), quality, effort, target size, metadata, progress and cancellation; automatic candidate comparison.
- Decoder and inspector with configurable limits and stable error codes.
- PSNR/SSIM metrics, colour quantisation, compression statistics.
- IO helpers: PNG (all bit depths, interlacing, ICC/EXIF/text), BMP (incl. RLE and bitfields), GIF (all frames), JPEG metadata, format detection, Lanczos resize, ZIP writer.

### CLI
- `smg encode | decode | info | benchmark | compare`, batch processing, duplicate detection, GIF frame extraction, JSON output; single-file build.

### Website
- Landing page with live in-browser compression demo.
- SMG Studio editor, converter, compressor, specification with byte explorer, benchmarks with live browser test, developer docs, downloads, privacy policy, about page.
- Installable PWA with offline support; strict CSP.

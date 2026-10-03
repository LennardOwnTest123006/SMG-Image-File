# Third-party software and assets

SMG's own code, format specification, artwork (logo, templates, benchmark screen pages) and documentation are © 2026 SMG contributors under the MIT license (see `LICENSE`). SMG builds on the following third-party components. We do not claim ownership of them or of the published algorithms listed at the end.

## Shipped in the website bundle

| Component | Version | License | Use |
|-----------|---------|---------|-----|
| React, React DOM, scheduler | 19.3 | MIT | UI framework |
| React Router (react-router, react-router-dom) | 7.18 | MIT | Client-side routing |
| cookie, set-cookie-parser | 1.1, 2.7 | MIT | React Router dependencies |
| marked | 18.0 | MIT | Renders the specification and developer docs |
| fflate | 0.8 | MIT | DEFLATE for PNG reading/writing (`@smg/codec/io`) |
| Inter (via @fontsource-variable/inter) | 5.3 | SIL OFL 1.1 | UI typeface, self-hosted |
| Space Grotesk (via @fontsource-variable/space-grotesk) | 5.3 | SIL OFL 1.1 | Display typeface, self-hosted |
| JetBrains Mono (via @fontsource-variable/jetbrains-mono) | 5.3 | SIL OFL 1.1 | Monospace typeface, self-hosted |

## Shipped in the CLI bundle (`smg-*.mjs`)

| Component | Version | License | Use |
|-----------|---------|---------|-----|
| fflate | 0.8 | MIT | PNG DEFLATE |
| jpeg-js | 0.4 | BSD-3-Clause | JPEG decoding/encoding without native dependencies |

Optional at runtime (installed separately by the user, not bundled):

| Component | License | Use |
|-----------|---------|-----|
| sharp | Apache-2.0 | WebP/AVIF/TIFF/HEIC/SVG input, WebP/AVIF output, reference encoders for `smg benchmark` |
| libvips and bundled codecs (via @img/sharp-libvips-*) | LGPL-3.0-or-later (libvips) and the respective licenses of libpng, mozjpeg, libwebp, libheif, aom, librsvg, etc. | Native image library used by sharp |

## Development and build tools (not shipped)

Vite (MIT), @vitejs/plugin-react (MIT), Vitest (MIT), TypeScript (Apache-2.0), esbuild (MIT), Playwright (Apache-2.0).

## Benchmark corpus images

| File | Source | License |
|------|--------|---------|
| `bench/sources/astronaut.png` | Portrait of astronaut Eileen Collins, NASA, via scikit-image | Public domain |
| `bench/sources/coffee.png` | Rachel Michetti, courtesy of Pikolo Espresso Bar, via scikit-image | CC0 |
| `bench/sources/chelsea.png` | Stefan van der Walt, via scikit-image | CC0 |

All other corpus images are generated from artwork and HTML pages in this repository (MIT).

## Algorithms and prior art

SMG implements published techniques; their inventors retain credit:

- Range coding (G. N. N. Martin, 1979); carry-propagating byte output after the LZMA SDK (Igor Pavlov, public domain).
- LOCO-I / JPEG-LS median edge detector and bias cancellation (Weinberger, Seroussi, Sapiro).
- CALIC gradient-adjusted prediction (Wu, Memon).
- Near-zero integer binarisation as in FLIF and JPEG XL modular mode (Sneyers, Wuille et al.).
- YCoCg-R reversible colour transform (Malvar, Sullivan).
- Subtract-green transform, backward references and colour cache as popularised by WebP lossless (Alakuijala et al.).
- CDF 9/7 wavelet (Cohen, Daubechies, Feauveau) with the lifting scheme (Sweldens), as standardised in JPEG 2000.
- Median-cut colour quantisation (Heckbert), k-means refinement, Floyd–Steinberg dithering.
- SSIM (Wang, Bovik, Sheikh, Simoncelli, 2004).
- Chunk criticality convention modelled on PNG (W3C/ISO 15948).

# SMG benchmark results

Generated 2026-10-03T12:49:42.454Z by `smg benchmark (SMG 1.0.0)`.

**Machine:** Intel(R) Xeon(R) Processor @ 2.80GHz · 4 cores · 17 GB · Linux 6.18.44-fc-v64 (x64) · Node v22.22.0

**Reference libraries:** libvips 8.18.7, libpng 1.6.58, mozjpeg 0826579, libwebp 1.6.0, libheif 1.23.5, aom 3.15.1 (sharp 0.35.5).

## Lossless (KB, smaller is better; ≠ = not bit-exact)

| Image | Size | SMG | PNG | WEBP | AVIF |
|---|---|---:|---:|---:|---:|
| photo-astronaut.png | 512×512 | 329.2 | 487.3 | 335.2 | 372.2 |
| photo-coffee.png | 600×400 | 333.4 | 505.8 | 336.5 | 379.6 |
| photo-cat.png | 451×300 | 151.6 | 247.5 | 153.7 | 178.2 |
| screenshot-code.png | 1280×800 | 49.4 | 102.5 | 39.3 | 145.5 |
| screenshot-dashboard.png | 1280×800 | 51.8 | 90.4 | 39.6 | 132.8 |
| screenshot-article.png | 1280×800 | 65.9 | 153.0 | 88.1 | 332.3 |
| logo-smg.png | 768×256 | 15.2 | 24.9 | 15.0 | 25.5 |
| logo-badge.png | 512×512 | 17.3 | 33.0 | 14.2 | 37.0 |
| icon-camera-128.png | 128×128 | 1.3 | 3.1 | 1.5 | 4.4 |
| icon-cloud-64.png | 64×64 | 0.5 | 1.2 | 0.6 | 1.9 |
| icon-favicon-32.png | 32×32 | 1.0 | 1.3 | 1.1 | 1.9 |
| illustration-landscape.png | 1024×640 | 18.0 | 38.9 | 17.2 | 42.7 |
| gradient-aurora.png | 1024×512 | 146.5 | 231.8 | 171.6 | 230.5 |
| gradient-sunset.png | 800×400 | 0.3 | 2.2 | 0.4 | 1.0 |
| **Total** | | **1181.5** | **1922.8** | **1214.3** | **1885.5** |

## Lossy at equal SSIM (KB; SMG quality 80; * = target not reached at quality 100)

| Image | Target SSIM | SMG | JPEG | WEBP | AVIF |
|---|---:|---:|---:|---:|---:|
| photo-astronaut.png | 0.9803 | 41.2 | 62.3 | 46.0 | 36.9 |
| photo-coffee.png | 0.9778 | 48.0 | 85.7 | 54.2 | 46.0 |
| photo-cat.png | 0.9822 | 20.6 | 35.0 | 28.2 | 21.9 |
| screenshot-code.png | 0.9950 | 22.3 | 61.9 | 23.4 | 17.6 |
| screenshot-dashboard.png | 0.9950 | 20.7 | 58.7 | 27.8 | 16.6 |
| screenshot-article.png | 0.9950 | 39.8 | 101.6 | 40.8 | 33.2 |
| logo-smg.png | 0.9950 | 5.0 | — | 5.2 | 2.4 |
| logo-badge.png | 0.9950 | 7.1 | — | 9.6 | 4.1 |
| icon-camera-128.png | 0.9950 | 1.3 | — | 1.3 | 1.1 |
| icon-cloud-64.png | 0.9950 | 0.5 | — | 0.6 | 0.8 |
| icon-favicon-32.png | 0.9934 | 0.6 | — | 0.6 | 0.8 |
| illustration-landscape.png | 0.9950 | 7.8 | 19.3 | 7.7 | 3.6 |
| gradient-aurora.png | 0.9950 | 1.1 | 4.9 | 2.1 | 1.0 |
| gradient-sunset.png | 0.9950 | 0.3 | 4.4 | 2.1 | 0.6 |

- vs JPEG (9 images where JPEG reached the target): SMG 201.8 KB vs 433.7 KB → -53.5%
- vs WEBP (14 images where WEBP reached the target): SMG 216.2 KB vs 249.8 KB → -13.4%
- vs AVIF (14 images where AVIF reached the target): SMG 216.2 KB vs 186.6 KB → +15.9%

import type { RgbaImage } from '../src/index.ts';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Kind = 'noise' | 'smooth' | 'flat' | 'graphic' | 'gray' | 'alpha' | 'binaryAlpha' | 'text';

/** Synthetic test images covering the content classes the codecs care about. */
export function makeImage(w: number, h: number, kind: Kind, seed = 1): RgbaImage & { data: Uint8Array } {
  const r = rng(seed);
  const d = new Uint8Array(w * h * 4);
  const colors = [
    [20, 24, 40], [255, 255, 255], [99, 102, 241], [236, 72, 153], [16, 185, 129], [245, 158, 11],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let R = 0, G = 0, B = 0, A = 255;
      switch (kind) {
        case 'noise':
          R = (r() * 256) | 0; G = (r() * 256) | 0; B = (r() * 256) | 0; A = (r() * 256) | 0;
          break;
        case 'smooth': {
          const fx = x / Math.max(1, w - 1), fy = y / Math.max(1, h - 1);
          R = Math.round(128 + 100 * Math.sin(fx * 6 + fy * 2) + (r() - 0.5) * 6);
          G = Math.round(120 + 90 * Math.cos(fy * 5 - fx) + (r() - 0.5) * 6);
          B = Math.round(140 + 80 * Math.sin((fx + fy) * 4) + (r() - 0.5) * 6);
          break;
        }
        case 'flat':
          [R, G, B] = colors[((x >> 4) + (y >> 4)) % 3];
          break;
        case 'graphic': {
          const c = colors[(Math.floor(x / 7) * 3 + Math.floor(y / 5) * 5) % colors.length];
          [R, G, B] = c;
          if ((x + y) % 11 === 0) { R = (R + G) >> 1; G = (G + B) >> 1; }
          break;
        }
        case 'gray': {
          const v = Math.round(128 + 120 * Math.sin(x / 9) * Math.cos(y / 7) + (r() - 0.5) * 10);
          R = G = B = Math.max(0, Math.min(255, v));
          break;
        }
        case 'alpha': {
          R = (x * 7) & 255; G = (y * 5) & 255; B = 128;
          const dx = x - w / 2, dy = y - h / 2;
          const dist = Math.sqrt(dx * dx + dy * dy) / (Math.min(w, h) / 2);
          A = Math.max(0, Math.min(255, Math.round((1.1 - dist) * 300)));
          break;
        }
        case 'binaryAlpha': {
          [R, G, B] = colors[(x * 3 + y) % 4];
          A = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 2.5) ** 2 ? 255 : 0;
          if (A === 0) { R = (r() * 256) | 0; G = 0; B = 0; } // junk colour under transparency
          break;
        }
        case 'text': {
          // pseudo glyph rows: repeated patterns with anti-aliased shades
          const glyph = ((x % 9) * 31 + (y % 13) * 17) % 7;
          const on = glyph < 2 && y % 13 < 10 && x % 9 < 7;
          const shade = on ? (glyph === 0 ? 30 : 140) : 250;
          R = G = B = shade;
          if (on && (y >> 6) % 2) { R = 120; G = 60; B = 200; }
          break;
        }
      }
      d[p] = Math.max(0, Math.min(255, R));
      d[p + 1] = Math.max(0, Math.min(255, G));
      d[p + 2] = Math.max(0, Math.min(255, B));
      d[p + 3] = A;
    }
  }
  return { width: w, height: h, data: d };
}

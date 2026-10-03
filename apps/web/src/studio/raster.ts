/** Pixel operations for SMG Studio: brushes, flood fill, adjustments and filters. */

export interface Adjustments {
  brightness: number; // -100..100
  contrast: number; // -100..100
  saturation: number; // -100..100
  exposure: number; // -2..2 (stops)
  hue: number; // -180..180 degrees
  temperature: number; // -100..100
  vibrance: number; // -100..100
  alpha: number; // -100..100 transparency shift
}

export const NO_ADJUST: Adjustments = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, hue: 0, temperature: 0, vibrance: 0, alpha: 0 };

export type FilterName = 'none' | 'grayscale' | 'sepia' | 'invert' | 'blur' | 'sharpen' | 'vignette' | 'pixelate' | 'posterize' | 'noise' | 'edges';

export const FILTERS: Array<{ id: FilterName; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'grayscale', label: 'Grayscale' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'invert', label: 'Invert' },
  { id: 'blur', label: 'Blur' },
  { id: 'sharpen', label: 'Sharpen' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'posterize', label: 'Posterize' },
  { id: 'noise', label: 'Film grain' },
  { id: 'edges', label: 'Edge detect' },
];

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Apply colour adjustments in place. */
export function applyAdjustments(d: Uint8ClampedArray, a: Adjustments): void {
  const exp = Math.pow(2, a.exposure);
  const c = a.contrast / 100;
  const cf = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
  const br = a.brightness * 1.28;
  const sat = 1 + a.saturation / 100;
  const vib = a.vibrance / 100;
  const temp = a.temperature * 0.4;
  const hue = a.hue / 360;
  const alphaShift = a.alpha / 100;
  for (let p = 0; p < d.length; p += 4) {
    let r = d[p] * exp + br, g = d[p + 1] * exp + br, b = d[p + 2] * exp + br;
    r = (r - 128) * cf + 128; g = (g - 128) * cf + 128; b = (b - 128) * cf + 128;
    r += temp; b -= temp;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (sat !== 1) { r = lum + (r - lum) * sat; g = lum + (g - lum) * sat; b = lum + (b - lum) * sat; }
    if (vib !== 0) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const amt = vib * (1 - (mx - mn) / 255);
      r = lum + (r - lum) * (1 + amt); g = lum + (g - lum) * (1 + amt); b = lum + (b - lum) * (1 + amt);
    }
    if (hue !== 0) {
      const [h, s, l] = rgbToHsl(clamp(r), clamp(g), clamp(b));
      [r, g, b] = hslToRgb((h + hue + 1) % 1, s, l);
    }
    d[p] = clamp(r); d[p + 1] = clamp(g); d[p + 2] = clamp(b);
    if (alphaShift !== 0) d[p + 3] = clamp(alphaShift > 0 ? d[p + 3] + (255 - d[p + 3]) * alphaShift : d[p + 3] * (1 + alphaShift));
  }
}

function boxBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Float32Array(src.length);
  const out = new Uint8ClampedArray(src.length);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = acc / win;
        const add = Math.min(w - 1, x + r + 1), rem = Math.max(0, x - r);
        acc += src[(y * w + add) * 4 + c] - src[(y * w + rem) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc / win;
        const add = Math.min(h - 1, y + r + 1), rem = Math.max(0, y - r);
        acc += tmp[(add * w + x) * 4 + c] - tmp[(rem * w + x) * 4 + c];
      }
    }
  }
  return out;
}

/** Apply a filter with strength 0..100; returns new pixel data. */
export function applyFilter(src: Uint8ClampedArray, w: number, h: number, f: FilterName, strength: number): Uint8ClampedArray {
  const t = strength / 100;
  const d = new Uint8ClampedArray(src);
  switch (f) {
    case 'none':
      return d;
    case 'grayscale':
    case 'sepia':
    case 'invert':
      for (let p = 0; p < d.length; p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        let nr: number, ng: number, nb: number;
        if (f === 'grayscale') nr = ng = nb = 0.299 * r + 0.587 * g + 0.114 * b;
        else if (f === 'sepia') { nr = 0.393 * r + 0.769 * g + 0.189 * b; ng = 0.349 * r + 0.686 * g + 0.168 * b; nb = 0.272 * r + 0.534 * g + 0.131 * b; }
        else { nr = 255 - r; ng = 255 - g; nb = 255 - b; }
        d[p] = clamp(r + (nr - r) * t); d[p + 1] = clamp(g + (ng - g) * t); d[p + 2] = clamp(b + (nb - b) * t);
      }
      return d;
    case 'blur': {
      const r = Math.max(1, Math.round(t * 20));
      // three box passes ≈ Gaussian
      return boxBlur(boxBlur(boxBlur(d, w, h, r), w, h, r), w, h, r);
    }
    case 'sharpen': {
      const blurred = boxBlur(d, w, h, 1);
      const amt = t * 2.5;
      for (let p = 0; p < d.length; p += 4) for (let c = 0; c < 3; c++) d[p + c] = clamp(d[p + c] + (d[p + c] - blurred[p + c]) * amt);
      return d;
    }
    case 'vignette': {
      const cx = w / 2, cy = h / 2, maxd = Math.hypot(cx, cy);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = Math.hypot(x - cx, y - cy) / maxd;
        const m = 1 - t * Math.pow(Math.max(0, k - 0.35) / 0.65, 1.6);
        const p = (y * w + x) * 4;
        d[p] *= m; d[p + 1] *= m; d[p + 2] *= m;
      }
      return d;
    }
    case 'pixelate': {
      const s = Math.max(2, Math.round(t * 40));
      for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const p = (y * w + x) * 4; for (let c = 0; c < 4; c++) acc[c] += src[p + c]; n++; }
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const p = (y * w + x) * 4; for (let c = 0; c < 4; c++) d[p + c] = acc[c] / n; }
      }
      return d;
    }
    case 'posterize': {
      const levels = Math.max(2, Math.round(16 - t * 14));
      const step = 255 / (levels - 1);
      for (let p = 0; p < d.length; p += 4) for (let c = 0; c < 3; c++) d[p + c] = Math.round(d[p + c] / step) * step;
      return d;
    }
    case 'noise': {
      let seed = 1234567;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
      for (let p = 0; p < d.length; p += 4) { const n = rnd() * 80 * t; d[p] = clamp(d[p] + n); d[p + 1] = clamp(d[p + 1] + n); d[p + 2] = clamp(d[p + 2] + n); }
      return d;
    }
    case 'edges': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const at = (xx: number, yy: number) => { const q = (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4; return 0.299 * src[q] + 0.587 * src[q + 1] + 0.114 * src[q + 2]; };
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const e = clamp(Math.hypot(gx, gy));
        for (let c = 0; c < 3; c++) d[p + c] = clamp(src[p + c] + (e - src[p + c]) * t);
      }
      return d;
    }
  }
}

/** Process a canvas through adjustments + filter; returns a new canvas. */
export function processCanvas(src: HTMLCanvasElement, adj: Adjustments, filter: FilterName, strength: number): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const id = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  let data = id.data;
  if (filter !== 'none') data = applyFilter(data, w, h, filter, strength) as Uint8ClampedArray<ArrayBuffer>;
  applyAdjustments(data, adj);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0);
  return out;
}

/** Scanline flood fill with colour tolerance (0..255). Returns the number of filled pixels. */
export function floodFill(canvas: HTMLCanvasElement, sx: number, sy: number, rgba: [number, number, number, number], tolerance: number): number {
  const w = canvas.width, h = canvas.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const i0 = (sy * w + sx) * 4;
  const t = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  if (t[0] === rgba[0] && t[1] === rgba[1] && t[2] === rgba[2] && t[3] === rgba[3]) return 0;
  const tol = tolerance * tolerance * 4;
  const match = (i: number) => {
    const dr = d[i] - t[0], dg = d[i + 1] - t[1], db = d[i + 2] - t[2], da = d[i + 3] - t[3];
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };
  const seen = new Uint8Array(w * h);
  const stack = [sx, sy];
  let filled = 0;
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    while (x >= 0 && !seen[y * w + x] && match((y * w + x) * 4)) x--;
    x++;
    let up = false, down = false;
    while (x < w && !seen[y * w + x] && match((y * w + x) * 4)) {
      const i = (y * w + x) * 4;
      seen[y * w + x] = 1;
      d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = rgba[3];
      filled++;
      if (y > 0) {
        const m = !seen[(y - 1) * w + x] && match(((y - 1) * w + x) * 4);
        if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false;
      }
      if (y < h - 1) {
        const m = !seen[(y + 1) * w + x] && match(((y + 1) * w + x) * 4);
        if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false;
      }
      x++;
    }
  }
  ctx.putImageData(img, 0, 0);
  return filled;
}

export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Brush tip with the given hardness (0..1). */
export function brushTip(size: number, color: string, hardness: number): HTMLCanvasElement {
  const s = Math.max(1, Math.ceil(size));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const r = s / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  const [R, G, B] = hexToRgba(color);
  g.addColorStop(0, `rgba(${R},${G},${B},1)`);
  g.addColorStop(Math.min(0.99, Math.max(0, hardness)), `rgba(${R},${G},${B},1)`);
  g.addColorStop(1, `rgba(${R},${G},${B},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** Stamp a soft brush along a segment. */
export function stampLine(ctx: CanvasRenderingContext2D, tip: HTMLCanvasElement, x0: number, y0: number, x1: number, y1: number): void {
  const s = tip.width;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(0.5, s * 0.12);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    ctx.drawImage(tip, x0 + (x1 - x0) * t - s / 2, y0 + (y1 - y0) * t - s / 2);
  }
}

/** Hard-edged pixel line (pencil): square stamps via Bresenham, no anti-aliasing. */
export function pixelLine(ctx: CanvasRenderingContext2D, color: string, size: number, x0: number, y0: number, x1: number, y1: number): void {
  ctx.fillStyle = color;
  let x = Math.floor(x0), y = Math.floor(y0);
  const xe = Math.floor(x1), ye = Math.floor(y1);
  const dx = Math.abs(xe - x), dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1;
  let err = dx + dy;
  const s = Math.max(1, Math.round(size));
  const off = Math.floor(s / 2);
  for (let guard = 0; guard < 100000; guard++) {
    ctx.fillRect(x - off, y - off, s, s);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** Flood-fill region mask (1 = inside) computed on arbitrary RGBA data. */
export function floodMask(d: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const i0 = (sy * w + sx) * 4;
  const t0 = d[i0], t1 = d[i0 + 1], t2 = d[i0 + 2], t3 = d[i0 + 3];
  const tol = tolerance * tolerance * 4;
  const match = (p: number) => {
    const i = p * 4;
    const a = d[i] - t0, b = d[i + 1] - t1, c = d[i + 2] - t2, e = d[i + 3] - t3;
    return a * a + b * b + c * c + e * e <= tol;
  };
  const stack = [sy * w + sx];
  mask[sy * w + sx] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p - x) / w;
    if (x > 0 && !mask[p - 1] && match(p - 1)) { mask[p - 1] = 1; stack.push(p - 1); }
    if (x < w - 1 && !mask[p + 1] && match(p + 1)) { mask[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !mask[p - w] && match(p - w)) { mask[p - w] = 1; stack.push(p - w); }
    if (y < h - 1 && !mask[p + w] && match(p + w)) { mask[p + w] = 1; stack.push(p + w); }
  }
  return mask;
}

/** Paint `rgba` into `canvas` wherever the document-space mask is set (layer offset ox, oy). */
export function paintMask(canvas: HTMLCanvasElement, mask: Uint8Array, mw: number, mh: number, ox: number, oy: number, rgba: [number, number, number, number]): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const a = rgba[3] / 255;
  let n = 0;
  for (let y = 0; y < canvas.height; y++) {
    const my = y + Math.round(oy);
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < canvas.width; x++) {
      const mx = x + Math.round(ox);
      if (mx < 0 || mx >= mw || !mask[my * mw + mx]) continue;
      const i = (y * canvas.width + x) * 4;
      // source-over blend of the fill colour
      const da = d[i + 3] / 255;
      const oa = a + da * (1 - a);
      if (oa > 0) {
        d[i] = (rgba[0] * a + d[i] * da * (1 - a)) / oa;
        d[i + 1] = (rgba[1] * a + d[i + 1] * da * (1 - a)) / oa;
        d[i + 2] = (rgba[2] * a + d[i + 2] * da * (1 - a)) / oa;
      }
      d[i + 3] = oa * 255;
      n++;
    }
  }
  ctx.putImageData(img, 0, 0);
  return n;
}

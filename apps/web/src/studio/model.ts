/**
 * SMG Studio document model.
 *
 * A document is an ordered stack of layers (index 0 = bottom). Pixel layers
 * own a canvas; vector-like layers (shape, text) stay editable. Documents are
 * treated as immutable values: every edit produces a new Doc (pixel canvases
 * are copy-on-write), which makes undo/redo a simple snapshot stack.
 */

export type Fill = string | { from: string; to: string; angle: number } | null;

export interface BaseLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blend: GlobalCompositeOperation;
  x: number;
  y: number;
  /** Degrees, clockwise, around the layer's centre. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/** Freehand paint layer. Its canvas is positioned at (x, y). */
export interface RasterLayer extends BaseLayer {
  kind: 'raster';
  canvas: HTMLCanvasElement;
}

/** Imported bitmap, drawn scaled to w × h. */
export interface ImageLayer extends BaseLayer {
  kind: 'image';
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

export interface ShapeLayer extends BaseLayer {
  kind: 'shape';
  shape: ShapeKind;
  /** Box size; for lines/arrows (w, h) is the vector from start to end. */
  w: number;
  h: number;
  fill: Fill;
  stroke: string | null;
  strokeWidth: number;
  radius: number;
}

export interface TextLayer extends BaseLayer {
  kind: 'text';
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Box width used for alignment. */
  w: number;
  letterSpacing: number;
  shadow: boolean;
}

export type Layer = RasterLayer | ImageLayer | ShapeLayer | TextLayer;

export interface Doc {
  id: string;
  name: string;
  width: number;
  height: number;
  /** null = transparent canvas */
  background: string | null;
  layers: Layer[];
  createdAt: number;
  updatedAt: number;
}

export const FONTS = [
  { label: 'Inter', value: '"Inter Variable", Inter, system-ui, sans-serif' },
  { label: 'Space Grotesk', value: '"Space Grotesk Variable", "Space Grotesk", sans-serif' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono Variable", ui-monospace, monospace' },
  { label: 'Georgia (serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: 'Impact-style', value: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
];

let counter = 0;
export const uid = (p = 'l') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

const base = (name: string): BaseLayer => ({ id: uid(), name, visible: true, locked: false, opacity: 1, blend: 'source-over', x: 0, y: 0, rotation: 0, flipX: false, flipY: false });

export function newRaster(doc: Pick<Doc, 'width' | 'height'>, name = 'Layer'): RasterLayer {
  return { ...base(name), kind: 'raster', canvas: makeCanvas(doc.width, doc.height) };
}

export function newImageLayer(canvas: HTMLCanvasElement, name: string, x: number, y: number, w: number, h: number): ImageLayer {
  return { ...base(name), kind: 'image', canvas, x, y, w, h };
}

export function newShape(shape: ShapeKind, x: number, y: number, w: number, h: number, style: Partial<ShapeLayer> = {}): ShapeLayer {
  const names: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' };
  return { ...base(names[shape]), kind: 'shape', shape, x, y, w, h, fill: shape === 'line' || shape === 'arrow' ? null : '#6a5cff', stroke: shape === 'line' || shape === 'arrow' ? '#14162b' : null, strokeWidth: 6, radius: 0, ...style };
}

export function newText(text: string, x: number, y: number, style: Partial<TextLayer> = {}): TextLayer {
  return { ...base(text.split('\n')[0].slice(0, 24) || 'Text'), kind: 'text', text, x, y, font: FONTS[0].value, size: 64, weight: 700, italic: false, color: '#14162b', align: 'left', lineHeight: 1.15, w: 600, letterSpacing: 0, shadow: false, ...style };
}

export function newDoc(width: number, height: number, background: string | null, name = 'Untitled'): Doc {
  const now = Date.now();
  const d: Doc = { id: uid('d'), name, width, height, background, layers: [], createdAt: now, updatedAt: now };
  d.layers = [newRaster(d, 'Layer 1')];
  return d;
}

// ---------- geometry ----------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function textFont(l: TextLayer): string {
  return `${l.italic ? 'italic ' : ''}${l.weight} ${l.size}px ${l.font}`;
}

export function textLines(l: TextLayer): string[] {
  return l.text.split('\n');
}

/** Height of a text block. */
export function textHeight(l: TextLayer): number {
  return Math.max(1, textLines(l).length) * l.size * l.lineHeight;
}

export function measureText(l: TextLayer): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = textFont(l);
  let w = 0;
  for (const line of textLines(l)) w = Math.max(w, measureCtx.measureText(line).width + Math.max(0, line.length - 1) * l.letterSpacing);
  return w;
}

/** Axis-aligned layer bounds in document coordinates (before rotation). */
export function layerBox(l: Layer): Box {
  switch (l.kind) {
    case 'raster':
      return { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
    case 'image':
      return { x: l.x, y: l.y, w: l.w, h: l.h };
    case 'shape':
      if (l.shape === 'line' || l.shape === 'arrow') {
        const pad = l.strokeWidth / 2 + (l.shape === 'arrow' ? l.strokeWidth * 2 : 0);
        return { x: Math.min(l.x, l.x + l.w) - pad, y: Math.min(l.y, l.y + l.h) - pad, w: Math.abs(l.w) + pad * 2, h: Math.abs(l.h) + pad * 2 };
      }
      return { x: Math.min(l.x, l.x + l.w), y: Math.min(l.y, l.y + l.h), w: Math.abs(l.w), h: Math.abs(l.h) };
    case 'text':
      return { x: l.x, y: l.y, w: l.w, h: textHeight(l) };
  }
}

/** Convert a document point into the layer's unrotated local frame (relative to its box). */
export function toLocal(l: Layer, px: number, py: number): [number, number] {
  const b = layerBox(l);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = (-l.rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Whether a document point hits a layer (alpha test for pixel layers). */
export function hitTest(l: Layer, px: number, py: number): boolean {
  if (!l.visible) return false;
  const [x, y] = toLocal(l, px, py);
  const b = layerBox(l);
  const tol = 4;
  if (x < b.x - tol || y < b.y - tol || x > b.x + b.w + tol || y > b.y + b.h + tol) return false;
  if (l.kind === 'raster' || l.kind === 'image') {
    let u = (x - b.x) / b.w, v = (y - b.y) / b.h;
    if (l.flipX) u = 1 - u;
    if (l.flipY) v = 1 - v;
    const cx = Math.floor(u * l.canvas.width), cy = Math.floor(v * l.canvas.height);
    if (cx < 0 || cy < 0 || cx >= l.canvas.width || cy >= l.canvas.height) return false;
    const a = l.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(cx, cy, 1, 1).data[3];
    return a > 10;
  }
  if (l.kind === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) {
    const x1 = l.x, y1 = l.y, x2 = l.x + l.w, y2 = l.y + l.h;
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / len2));
    const d = Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
    return d <= l.strokeWidth / 2 + 6;
  }
  return true;
}

export function cloneLayer(l: Layer, deep = false): Layer {
  if ((l.kind === 'raster' || l.kind === 'image') && deep) return { ...l, canvas: cloneCanvas(l.canvas) };
  return { ...l };
}

export function replaceLayer(doc: Doc, id: string, patch: Partial<Layer> | ((l: Layer) => Layer)): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? (typeof patch === 'function' ? patch(l) : ({ ...l, ...patch } as Layer)) : l)), updatedAt: Date.now() };
}

/** Rendering of Studio documents onto 2D canvases. */
import { layerBox, textFont, textLines, type Doc, type Fill, type Layer } from './model.ts';

export interface LiveStroke {
  layerId: string;
  canvas: HTMLCanvasElement;
  opacity: number;
  erase: boolean;
}

export interface RenderOptions {
  /** Paint the document background colour (false → leave transparent). */
  background?: boolean;
  /** Temporary pixel replacements (e.g. adjustment previews). */
  overrides?: Map<string, HTMLCanvasElement>;
  /** In-progress brush/eraser stroke drawn on top of its layer. */
  live?: LiveStroke | null;
  /** Before/after split for an adjusted layer: x < split·width shows `before`. */
  compare?: { layerId: string; before: HTMLCanvasElement; split: number } | null;
  /** Layers to skip (e.g. while editing). */
  hidden?: Set<string>;
}

function fillStyle(ctx: CanvasRenderingContext2D, fill: Fill, x: number, y: number, w: number, h: number): string | CanvasGradient | null {
  if (!fill) return null;
  if (typeof fill === 'string') return fill;
  const a = (fill.angle * Math.PI) / 180;
  const cx = x + w / 2, cy = y + h / 2;
  const r = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
  const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  g.addColorStop(0, fill.from);
  g.addColorStop(1, fill.to);
  return g;
}

function withTransform(ctx: CanvasRenderingContext2D, l: Layer, draw: () => void): void {
  const b = layerBox(l);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  ctx.save();
  if (l.rotation || l.flipX || l.flipY) {
    ctx.translate(cx, cy);
    if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180);
    ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
    ctx.translate(-cx, -cy);
  }
  draw();
  ctx.restore();
}

export function drawLayerContent(ctx: CanvasRenderingContext2D, l: Layer, src?: HTMLCanvasElement): void {
  switch (l.kind) {
    case 'raster':
      ctx.drawImage(src ?? l.canvas, l.x, l.y);
      break;
    case 'image':
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src ?? l.canvas, l.x, l.y, l.w, l.h);
      break;
    case 'shape': {
      const b = layerBox(l);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (l.shape === 'line' || l.shape === 'arrow') {
        const x2 = l.x + l.w, y2 = l.y + l.h;
        ctx.strokeStyle = l.stroke ?? '#000';
        ctx.lineWidth = l.strokeWidth;
        const ang = Math.atan2(l.h, l.w);
        const head = l.strokeWidth * 3 + 6;
        const ex = l.shape === 'arrow' ? x2 - Math.cos(ang) * head * 0.6 : x2;
        const ey = l.shape === 'arrow' ? y2 - Math.sin(ang) * head * 0.6 : y2;
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        if (l.shape === 'arrow') {
          ctx.fillStyle = l.stroke ?? '#000';
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head);
          ctx.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      ctx.beginPath();
      if (l.shape === 'rect') {
        if (l.radius > 0) ctx.roundRect(b.x, b.y, b.w, b.h, Math.min(l.radius, b.w / 2, b.h / 2));
        else ctx.rect(b.x, b.y, b.w, b.h);
      } else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      const f = fillStyle(ctx, l.fill, b.x, b.y, b.w, b.h);
      if (f) {
        ctx.fillStyle = f;
        ctx.fill();
      }
      if (l.stroke && l.strokeWidth > 0) {
        ctx.strokeStyle = l.stroke;
        ctx.lineWidth = l.strokeWidth;
        ctx.stroke();
      }
      break;
    }
    case 'text': {
      ctx.font = textFont(l);
      ctx.fillStyle = l.color;
      ctx.textBaseline = 'top';
      ctx.textAlign = l.align;
      if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${l.letterSpacing}px`;
      if (l.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = l.size * 0.12;
        ctx.shadowOffsetY = l.size * 0.05;
      }
      const ax = l.align === 'left' ? l.x : l.align === 'center' ? l.x + l.w / 2 : l.x + l.w;
      textLines(l).forEach((line, i) => ctx.fillText(line, ax, l.y + i * l.size * l.lineHeight + (l.size * (l.lineHeight - 1)) / 2));
      break;
    }
  }
}

let scratch: HTMLCanvasElement | null = null;

export function renderDoc(ctx: CanvasRenderingContext2D, doc: Doc, opts: RenderOptions = {}): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (opts.background !== false && doc.background) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  for (const l of doc.layers) {
    if (!l.visible || opts.hidden?.has(l.id)) continue;
    const live = opts.live && opts.live.layerId === l.id ? opts.live : null;
    let src = opts.overrides?.get(l.id);
    if (live && (l.kind === 'raster' || l.kind === 'image')) {
      // Composite the in-progress stroke onto a scratch copy of the layer.
      scratch ??= document.createElement('canvas');
      const base = src ?? l.canvas;
      scratch.width = base.width;
      scratch.height = base.height;
      const sc = scratch.getContext('2d')!;
      sc.clearRect(0, 0, base.width, base.height);
      sc.drawImage(base, 0, 0);
      sc.globalAlpha = live.opacity;
      sc.globalCompositeOperation = live.erase ? 'destination-out' : 'source-over';
      sc.drawImage(live.canvas, 0, 0, base.width, base.height);
      sc.globalAlpha = 1;
      sc.globalCompositeOperation = 'source-over';
      src = scratch;
    }
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = l.blend;
    if (opts.compare && opts.compare.layerId === l.id) {
      const split = opts.compare.split * doc.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, split, doc.height);
      ctx.clip();
      withTransform(ctx, l, () => drawLayerContent(ctx, l, opts.compare!.before));
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(split, 0, doc.width - split, doc.height);
      ctx.clip();
      withTransform(ctx, l, () => drawLayerContent(ctx, l, src));
      ctx.restore();
    } else {
      withTransform(ctx, l, () => drawLayerContent(ctx, l, src));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

/** Flatten the document to RGBA pixels (for export). */
export function flatten(doc: Doc, background = true): { width: number; height: number; data: Uint8Array } {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  renderDoc(ctx, doc, { background });
  const d = ctx.getImageData(0, 0, doc.width, doc.height);
  return { width: doc.width, height: doc.height, data: new Uint8Array(d.data.buffer) };
}

/** Render a single layer into its own document-sized canvas (for rasterising). */
export function rasterizeLayer(doc: Doc, l: Layer): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext('2d')!;
  withTransform(ctx, l, () => drawLayerContent(ctx, l));
  return c;
}

/** Small preview of a layer for the layers panel. */
export function layerThumb(doc: Doc, l: Layer, size = 40): string {
  const s = Math.min(size / doc.width, size / doc.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(doc.width * s));
  c.height = Math.max(1, Math.round(doc.height * s));
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  withTransform(ctx, l, () => drawLayerContent(ctx, l));
  return c.toDataURL();
}

export function docThumb(doc: Doc, size = 160): string {
  const s = Math.min(size / doc.width, size / doc.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(doc.width * s));
  c.height = Math.max(1, Math.round(doc.height * s));
  const ctx = c.getContext('2d')!;
  const full = document.createElement('canvas');
  full.width = doc.width;
  full.height = doc.height;
  renderDoc(full.getContext('2d')!, doc);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

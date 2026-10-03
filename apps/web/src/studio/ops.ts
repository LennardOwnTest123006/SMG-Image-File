/** Pure document operations for SMG Studio (each returns a new Doc). */
import type { RgbaImage } from '@smg/codec';
import { layerBox, makeCanvas, newImageLayer, newRaster, type Box, type Doc, type Layer } from './model.ts';
import { rasterizeLayer, renderDoc } from './render.ts';

const touch = (d: Doc): Doc => ({ ...d, updatedAt: Date.now() });

export function resizeDoc(doc: Doc, W: number, H: number): Doc {
  const sx = W / doc.width, sy = H / doc.height, s = (sx + sy) / 2;
  const layers = doc.layers.map((l): Layer => {
    switch (l.kind) {
      case 'raster': {
        const c = makeCanvas(l.canvas.width * sx, l.canvas.height * sy);
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(l.canvas, 0, 0, c.width, c.height);
        return { ...l, canvas: c, x: l.x * sx, y: l.y * sy };
      }
      case 'image':
        return { ...l, x: l.x * sx, y: l.y * sy, w: l.w * sx, h: l.h * sy };
      case 'shape':
        return { ...l, x: l.x * sx, y: l.y * sy, w: l.w * sx, h: l.h * sy, strokeWidth: Math.max(1, l.strokeWidth * s), radius: l.radius * s };
      case 'text':
        return { ...l, x: l.x * sx, y: l.y * sy, w: l.w * sx, size: Math.max(4, l.size * sy) };
    }
  });
  return touch({ ...doc, width: W, height: H, layers });
}

export function canvasSizeDoc(doc: Doc, W: number, H: number, anchor: [number, number]): Doc {
  const dx = (W - doc.width) * anchor[0], dy = (H - doc.height) * anchor[1];
  return touch({ ...doc, width: W, height: H, layers: doc.layers.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })) });
}

function rotateCanvas90(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.height, src.width);
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

function flipCanvas(src: HTMLCanvasElement, horizontal: boolean): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  if (horizontal) { ctx.translate(c.width, 0); ctx.scale(-1, 1); } else { ctx.translate(0, c.height); ctx.scale(1, -1); }
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Rotate the whole document 90° clockwise `turns` times. */
export function rotateDoc(doc: Doc, turns: number): Doc {
  let d = doc;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const H = d.height;
    const layers = d.layers.map((l): Layer => {
      const b = layerBox(l);
      if (l.kind === 'raster' && !l.rotation) {
        return { ...l, canvas: rotateCanvas90(l.canvas), x: H - (l.y + l.canvas.height), y: l.x, flipX: l.flipY, flipY: l.flipX };
      }
      if (l.kind === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) {
        return { ...l, x: H - l.y, y: l.x, w: -l.h, h: l.w };
      }
      // Rotate the centre and add 90° to the layer's own rotation.
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const ncx = H - cy, ncy = cx;
      return { ...l, x: l.x + (ncx - cx), y: l.y + (ncy - cy), rotation: (l.rotation + 90) % 360 } as Layer;
    });
    d = touch({ ...d, width: d.height, height: d.width, layers });
  }
  return d;
}

export function flipDoc(doc: Doc, horizontal: boolean): Doc {
  const W = doc.width, H = doc.height;
  const layers = doc.layers.map((l): Layer => {
    const b = layerBox(l);
    if (l.kind === 'raster' && !l.rotation) {
      return horizontal ? { ...l, canvas: flipCanvas(l.canvas, true), x: W - (l.x + l.canvas.width) } : { ...l, canvas: flipCanvas(l.canvas, false), y: H - (l.y + l.canvas.height) };
    }
    if (l.kind === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) {
      return horizontal ? { ...l, x: W - l.x, w: -l.w } : { ...l, y: H - l.y, h: -l.h };
    }
    if (horizontal) return { ...l, x: l.x + (W - (b.x + b.w) - b.x), flipX: !l.flipX, rotation: (360 - l.rotation) % 360 } as Layer;
    return { ...l, y: l.y + (H - (b.y + b.h) - b.y), flipY: !l.flipY, rotation: (360 - l.rotation) % 360 } as Layer;
  });
  return touch({ ...doc, layers });
}

export function cropDoc(doc: Doc, r: Box): Doc {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
  const layers = doc.layers.map((l): Layer => {
    if (l.kind === 'raster' && !l.rotation && !l.flipX && !l.flipY) {
      const c = makeCanvas(w, h);
      c.getContext('2d')!.drawImage(l.canvas, l.x - x, l.y - y);
      return { ...l, canvas: c, x: 0, y: 0 };
    }
    return { ...l, x: l.x - x, y: l.y - y } as Layer;
  });
  return touch({ ...doc, width: w, height: h, layers });
}

export function rasterize(doc: Doc, id: string): Doc {
  return touch({
    ...doc,
    layers: doc.layers.map((l) => (l.id === id ? { ...newRaster(doc, l.name), id: l.id, canvas: rasterizeLayer(doc, { ...l, opacity: 1 }), opacity: l.opacity, blend: l.blend, visible: l.visible } : l)),
  });
}

export function mergeDown(doc: Doc, id: string): Doc {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i <= 0) return doc;
  const upper = doc.layers[i], lower = doc.layers[i - 1];
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(rasterizeLayer(doc, lower), 0, 0);
  ctx.globalAlpha = upper.opacity / Math.max(0.0001, 1);
  ctx.globalCompositeOperation = upper.blend;
  if (upper.visible) ctx.drawImage(rasterizeLayer(doc, upper), 0, 0);
  const merged: Layer = { ...newRaster(doc, lower.name), id: lower.id, canvas: c, opacity: lower.opacity, blend: lower.blend, visible: lower.visible };
  const layers = [...doc.layers];
  layers.splice(i - 1, 2, merged);
  return touch({ ...doc, layers });
}

export function alignLayer(doc: Doc, l: Layer, a: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): Partial<Layer> {
  const b = layerBox(l);
  let dx = 0, dy = 0;
  if (a === 'left') dx = -b.x;
  if (a === 'hcenter') dx = (doc.width - b.w) / 2 - b.x;
  if (a === 'right') dx = doc.width - b.w - b.x;
  if (a === 'top') dy = -b.y;
  if (a === 'vcenter') dy = (doc.height - b.h) / 2 - b.y;
  if (a === 'bottom') dy = doc.height - b.h - b.y;
  return { x: l.x + dx, y: l.y + dy };
}

/** Create an image layer from pixels, scaled to fit inside the document. */
export function imageLayerFrom(doc: Doc, img: RgbaImage, name: string): Layer {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength).slice(), img.width, img.height), 0, 0);
  const s = Math.min(1, (doc.width * 0.9) / img.width, (doc.height * 0.9) / img.height);
  const w = img.width * s, h = img.height * s;
  return newImageLayer(c, name, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
}

/** Composite of all visible layers as ImageData (for eyedropper / sample-all fill). */
export function compositeData(doc: Doc): ImageData {
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  renderDoc(ctx, doc);
  return ctx.getImageData(0, 0, doc.width, doc.height);
}

/** Components that render RGBA images: plain canvas and before/after comparison. */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RgbaImage } from '@smg/codec';
import { Icon } from './Icon.tsx';

function paint(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  ctx.putImageData(new ImageData(data.slice(), img.width, img.height), 0, 0);
}

export function ImageCanvas({ image, style, className, pixelated }: { image: RgbaImage | null; style?: CSSProperties; className?: string; pixelated?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && image) paint(ref.current, image);
  }, [image]);
  return <canvas ref={ref} className={className} style={{ imageRendering: pixelated ? 'pixelated' : 'auto', ...style }} />;
}

/** Thumbnail data URL (downscaled) for lists. */
export function makeThumb(img: RgbaImage, max = 112): string {
  const c = document.createElement('canvas');
  paint(c, img);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(img.width * s));
  t.height = Math.max(1, Math.round(img.height * s));
  const ctx = t.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}

/**
 * Before/after comparison with a draggable divider. Supports zoom (1:1 pixel
 * inspection) by scrolling inside the frame.
 */
export function CompareSlider({ before, after, beforeLabel = 'Original', afterLabel = 'SMG', height = 420 }: { before: RgbaImage; after: RgbaImage | null; beforeLabel?: string; afterLabel?: string; height?: number | string }) {
  const [pos, setPos] = useState(0.5);
  const [zoom, setZoom] = useState<'fit' | '1:1' | '2:1'>('fit');
  const frame = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLCanvasElement>(null);
  const b = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (a.current) paint(a.current, before);
  }, [before]);
  useEffect(() => {
    if (b.current && after) paint(b.current, after);
  }, [after]);

  const move = (clientX: number) => {
    const el = frame.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  const scale = zoom === 'fit' ? null : zoom === '1:1' ? 1 : 2;
  const innerStyle: CSSProperties = scale
    ? { position: 'relative', width: before.width * scale, height: before.height * scale }
    : { position: 'absolute', inset: 0 };
  const canvasStyle: CSSProperties = scale
    ? { width: before.width * scale, height: before.height * scale, imageRendering: scale > 1 ? 'pixelated' : 'auto' }
    : { width: '100%', height: '100%', objectFit: 'contain' };

  return (
    <div>
      <div
        ref={frame}
        className="compare"
        style={{ height, overflow: scale ? 'auto' : 'hidden', cursor: 'ew-resize' }}
        onPointerDown={(e) => {
          if (scale && e.pointerType === 'mouse' && e.button !== 0) return;
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          move(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && move(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 0.05));
          if (e.key === 'ArrowRight') setPos((p) => Math.min(1, p + 0.05));
        }}
        tabIndex={0}
        role="slider"
        aria-label="Comparison divider"
        aria-valuenow={Math.round(pos * 100)}
      >
        <div style={innerStyle}>
          <canvas ref={a} style={{ ...canvasStyle, position: scale ? 'absolute' : 'absolute', inset: 0 }} />
          {after && <canvas ref={b} style={{ ...canvasStyle, position: 'absolute', inset: 0, clipPath: `inset(0 0 0 ${pos * 100}%)` }} />}
        </div>
        {after && !scale && (
          <>
            <div className="divider" style={{ left: `${pos * 100}%` }} />
            <div className="handle" style={{ left: `${pos * 100}%` }}>
              <Icon name="compare" size={18} />
            </div>
          </>
        )}
        <span className="tag" style={{ left: 10 }}>{beforeLabel}</span>
        {after && <span className="tag" style={{ right: 10 }}>{afterLabel}</span>}
      </div>
      <div className="row" style={{ marginTop: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {scale ? 'Zoomed: the divider uses the frame width; scroll to pan.' : 'Drag the divider to compare.'}
        </span>
        <div className="segmented" role="radiogroup" aria-label="Zoom">
          {(['fit', '1:1', '2:1'] as const).map((z) => (
            <button key={z} type="button" className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>
              {z === 'fit' ? 'Fit' : z}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Studio side panels: layers, properties, adjustments. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Range, Segmented } from '../components/ui.tsx';
import { FONTS, layerBox, type Doc, type Fill, type Layer, type ShapeLayer, type TextLayer } from './model.ts';
import { FILTERS, NO_ADJUST, type Adjustments, type FilterName } from './raster.ts';
import { layerThumb } from './render.ts';

const BLENDS: GlobalCompositeOperation[] = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
const blendLabel = (b: string) => (b === 'source-over' ? 'Normal' : b.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

/* ---------------- Layers ---------------- */
export function LayersPanel(props: {
  doc: Doc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onLock: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, dir: 1 | -1) => void;
  onReorder: (id: string, toIndex: number) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMergeDown: () => void;
  onOpacity: (v: number, final: boolean) => void;
  onBlend: (b: GlobalCompositeOperation) => void;
}) {
  const { doc, selectedId } = props;
  const sel = doc.layers.find((l) => l.id === selectedId) ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const thumbs = useMemo(() => new Map(doc.layers.map((l) => [l.id, layerThumb(doc, l, 36)])), [doc]);
  const ordered = [...doc.layers].reverse();
  const selIndex = sel ? doc.layers.indexOf(sel) : -1;
  return (
    <div className="panel">
      <div className="panel-head">
        <span>Layers</span>
        <span className="spacer" />
        <button className="btn icon sm ghost" title="New layer (Ctrl+Shift+N)" onClick={props.onAdd} aria-label="New layer"><Icon name="plus" size={15} /></button>
        <button className="btn icon sm ghost" title="Duplicate (Ctrl+D)" onClick={props.onDuplicate} disabled={!sel} aria-label="Duplicate layer"><Icon name="copy" size={15} /></button>
        <button className="btn icon sm ghost" title="Merge down" onClick={props.onMergeDown} disabled={selIndex <= 0} aria-label="Merge down"><Icon name="layers" size={15} /></button>
        <button className="btn icon sm ghost danger" title="Delete (Del)" onClick={props.onDelete} disabled={!sel} aria-label="Delete layer"><Icon name="trash" size={15} /></button>
      </div>
      <div className="layer-list" data-testid="layer-list">
        {ordered.map((l) => (
          <div
            key={l.id}
            className={`layer-row${l.id === selectedId ? ' on' : ''}${dragId === l.id ? ' dragging' : ''}`}
            onClick={() => props.onSelect(l.id)}
            draggable={editing !== l.id}
            onDragStart={() => setDragId(l.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== l.id) props.onReorder(dragId, doc.layers.findIndex((x) => x.id === l.id));
              setDragId(null);
            }}
          >
            <button className="icon-toggle" onClick={(e) => { e.stopPropagation(); props.onToggle(l.id); }} aria-label={l.visible ? 'Hide layer' : 'Show layer'} title={l.visible ? 'Hide' : 'Show'}>
              <Icon name={l.visible ? 'eye' : 'eyeOff'} size={15} />
            </button>
            <img className="layer-thumb checker" src={thumbs.get(l.id)} alt="" />
            {editing === l.id ? (
              <input
                className="input sm"
                autoFocus
                defaultValue={l.name}
                onBlur={(e) => { props.onRename(l.id, e.target.value || l.name); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="layer-name" onDoubleClick={() => setEditing(l.id)} title="Double-click to rename">
                {l.name}
                <span className="layer-kind">{l.kind}</span>
              </span>
            )}
            <button className="icon-toggle" onClick={(e) => { e.stopPropagation(); props.onLock(l.id); }} aria-label={l.locked ? 'Unlock' : 'Lock'} title={l.locked ? 'Unlock' : 'Lock'} style={{ opacity: l.locked ? 1 : 0.35 }}>
              <Icon name="lock" size={14} />
            </button>
          </div>
        ))}
      </div>
      {sel && (
        <div className="stack" style={{ gap: 10, marginTop: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => props.onMove(sel.id, 1)} disabled={selIndex >= doc.layers.length - 1} title="Bring forward (Ctrl+])"><Icon name="up" size={14} /> Up</button>
            <button className="btn sm" onClick={() => props.onMove(sel.id, -1)} disabled={selIndex <= 0} title="Send backward (Ctrl+[)"><Icon name="downArrow" size={14} /> Down</button>
            <select className="input sm" style={{ flex: 1 }} value={sel.blend} onChange={(e) => props.onBlend(e.target.value as GlobalCompositeOperation)} aria-label="Blend mode">
              {BLENDS.map((b) => <option key={b} value={b}>{blendLabel(b)}</option>)}
            </select>
          </div>
          <OpacitySlider key={sel.id} value={sel.opacity} onChange={props.onOpacity} />
        </div>
      )}
    </div>
  );
}

function OpacitySlider({ value, onChange }: { value: number; onChange: (v: number, final: boolean) => void }) {
  const [v, setV] = useState(Math.round(value * 100));
  useEffect(() => setV(Math.round(value * 100)), [value]);
  return (
    <div onPointerUp={() => onChange(v / 100, true)} onKeyUp={() => onChange(v / 100, true)}>
      <Range label="Opacity" value={v} min={0} max={100} format={(x) => `${x}%`} onChange={(x) => { setV(x); onChange(x / 100, false); }} />
    </div>
  );
}

/* ---------------- Properties ---------------- */
function NumberField({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  const [txt, setTxt] = useState(String(Math.round(value * 100) / 100));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTxt(String(Math.round(value * 100) / 100));
  }, [value]);
  return (
    <label className="num-field">
      <span>{label}</span>
      <input
        className="input sm"
        type="number"
        step={step}
        min={min}
        max={max}
        value={txt}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setTxt(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => {
          focused.current = false;
          setTxt(String(Math.round(value * 100) / 100));
        }}
      />
    </label>
  );
}

function FillEditor({ value, onChange }: { value: Fill; onChange: (f: Fill) => void }) {
  const kind = value === null ? 'none' : typeof value === 'string' ? 'solid' : 'gradient';
  const solid = typeof value === 'string' ? toHex(value) : value ? value.from : '#6a5cff';
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Segmented
        value={kind}
        ariaLabel="Fill type"
        onChange={(k) => onChange(k === 'none' ? null : k === 'solid' ? solid : { from: solid, to: '#a855f7', angle: 45 })}
        options={[{ value: 'none', label: 'None' }, { value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }]}
      />
      {kind === 'solid' && <input type="color" value={solid} onChange={(e) => onChange(e.target.value)} aria-label="Fill colour" />}
      {kind === 'gradient' && value && typeof value !== 'string' && (
        <div className="row" style={{ gap: 8 }}>
          <input type="color" value={toHex(value.from)} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="Gradient start" />
          <input type="color" value={toHex(value.to)} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="Gradient end" />
          <div style={{ flex: 1 }}>
            <Range label="Angle" value={value.angle} min={0} max={360} format={(v) => `${v}°`} onChange={(angle) => onChange({ ...value, angle })} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Normalise any CSS colour to #rrggbb for <input type=color>. */
export function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  const v = ctx.fillStyle;
  if (v.startsWith('#')) return v;
  const m = v.match(/\d+/g);
  return m ? '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#000000';
}

export function PropertiesPanel({ doc, layer, onPatch, onAlign, onRasterize, onFlip, onRotate, textRef }: {
  doc: Doc;
  layer: Layer;
  onPatch: (patch: Partial<Layer>, key: string) => void;
  onAlign: (a: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => void;
  onRasterize: () => void;
  onFlip: (h: boolean) => void;
  onRotate: (deg: number) => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const b = layerBox(layer);
  const showWH = layer.kind === 'image' || (layer.kind === 'shape' && layer.shape !== 'line' && layer.shape !== 'arrow');
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid2">
        <NumberField label="X" value={b.x} onChange={(v) => onPatch(moveTo(layer, v, b.y), 'pos')} />
        <NumberField label="Y" value={b.y} onChange={(v) => onPatch(moveTo(layer, b.x, v), 'pos')} />
        {showWH && (
          <>
            <NumberField label="W" value={b.w} min={1} onChange={(v) => onPatch({ w: Math.max(1, v) } as Partial<Layer>, 'size')} />
            <NumberField label="H" value={b.h} min={1} onChange={(v) => onPatch({ h: Math.max(1, v) } as Partial<Layer>, 'size')} />
          </>
        )}
        {layer.kind === 'text' && <NumberField label="Box W" value={layer.w} min={10} onChange={(v) => onPatch({ w: Math.max(10, v) } as Partial<Layer>, 'size')} />}
        <NumberField label="Rotate°" value={layer.rotation} onChange={(v) => onPatch({ rotation: ((v % 360) + 360) % 360 }, 'rot')} />
      </div>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Align to canvas</div>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {([['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']] as const).map(([a, g]) => (
            <button key={a} className="btn icon sm" title={`Align ${a}`} onClick={() => onAlign(a)} aria-label={`Align ${a}`}>{g}</button>
          ))}
          <span className="spacer" />
          <button className="btn icon sm" title="Flip horizontal" onClick={() => onFlip(true)} aria-label="Flip horizontal"><Icon name="flipH" size={15} /></button>
          <button className="btn icon sm" title="Flip vertical" onClick={() => onFlip(false)} aria-label="Flip vertical"><Icon name="flipV" size={15} /></button>
          <button className="btn icon sm" title="Rotate 90°" onClick={() => onRotate(90)} aria-label="Rotate 90"><Icon name="rotate" size={15} /></button>
        </div>
      </div>
      {layer.kind === 'text' && <TextProps layer={layer} onPatch={onPatch} textRef={textRef} />}
      {layer.kind === 'shape' && <ShapeProps layer={layer} onPatch={onPatch} />}
      {(layer.kind === 'text' || layer.kind === 'shape') && (
        <button className="btn sm" onClick={onRasterize} title="Convert to a pixel layer so you can paint, fill or apply filters">
          Rasterize layer
        </button>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        Canvas {doc.width}×{doc.height}px
      </div>
    </div>
  );
}

function moveTo(l: Layer, x: number, y: number): Partial<Layer> {
  const b = layerBox(l);
  return { x: l.x + (x - b.x), y: l.y + (y - b.y) };
}

function TextProps({ layer, onPatch, textRef }: { layer: TextLayer; onPatch: (p: Partial<Layer>, key: string) => void; textRef: React.RefObject<HTMLTextAreaElement | null> }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="field">
        <label htmlFor="text-content">Text</label>
        <textarea id="text-content" ref={textRef} className="input" rows={3} value={layer.text} onChange={(e) => onPatch({ text: e.target.value, name: e.target.value.split('\n')[0].slice(0, 24) || 'Text' } as Partial<Layer>, 'text')} data-testid="text-content" />
      </div>
      <div className="field">
        <label htmlFor="text-font">Font</label>
        <select id="text-font" className="input sm" value={layer.font} onChange={(e) => onPatch({ font: e.target.value } as Partial<Layer>, 'font')}>
          {FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div className="grid2">
        <NumberField label="Size" value={layer.size} min={4} max={1000} onChange={(v) => onPatch({ size: Math.max(4, v) } as Partial<Layer>, 'tsize')} />
        <NumberField label="Weight" value={layer.weight} step={100} min={100} max={900} onChange={(v) => onPatch({ weight: Math.min(900, Math.max(100, Math.round(v / 100) * 100)) } as Partial<Layer>, 'weight')} />
        <NumberField label="Line ht" value={layer.lineHeight} step={0.05} min={0.6} max={3} onChange={(v) => onPatch({ lineHeight: v } as Partial<Layer>, 'lh')} />
        <NumberField label="Spacing" value={layer.letterSpacing} step={0.5} onChange={(v) => onPatch({ letterSpacing: v } as Partial<Layer>, 'ls')} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input type="color" value={toHex(layer.color)} onChange={(e) => onPatch({ color: e.target.value } as Partial<Layer>, 'color')} aria-label="Text colour" />
        <Segmented value={layer.align} ariaLabel="Alignment" onChange={(align) => onPatch({ align } as Partial<Layer>, 'align')} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
      </div>
      <div className="row" style={{ gap: 14 }}>
        <label className="check"><input type="checkbox" checked={layer.italic} onChange={(e) => onPatch({ italic: e.target.checked } as Partial<Layer>, 'italic')} /> Italic</label>
        <label className="check"><input type="checkbox" checked={layer.shadow} onChange={(e) => onPatch({ shadow: e.target.checked } as Partial<Layer>, 'shadow')} /> Shadow</label>
      </div>
    </div>
  );
}

function ShapeProps({ layer, onPatch }: { layer: ShapeLayer; onPatch: (p: Partial<Layer>, key: string) => void }) {
  const isLine = layer.shape === 'line' || layer.shape === 'arrow';
  return (
    <div className="stack" style={{ gap: 10 }}>
      {!isLine && (
        <div className="field">
          <span className="label">Fill</span>
          <FillEditor value={layer.fill} onChange={(fill) => onPatch({ fill } as Partial<Layer>, 'fill')} />
        </div>
      )}
      <div className="field">
        <span className="label">Stroke</span>
        <div className="row" style={{ gap: 8 }}>
          <label className="check"><input type="checkbox" checked={!!layer.stroke} onChange={(e) => onPatch({ stroke: e.target.checked ? '#14162b' : null } as Partial<Layer>, 'stroke')} /> On</label>
          {layer.stroke && <input type="color" value={toHex(layer.stroke)} onChange={(e) => onPatch({ stroke: e.target.value } as Partial<Layer>, 'stroke')} aria-label="Stroke colour" />}
          <div style={{ flex: 1 }}><Range label="Width" value={layer.strokeWidth} min={1} max={80} onChange={(strokeWidth) => onPatch({ strokeWidth } as Partial<Layer>, 'sw')} /></div>
        </div>
      </div>
      {layer.shape === 'rect' && <Range label="Corner radius" value={layer.radius} min={0} max={Math.round(Math.min(Math.abs(layer.w), Math.abs(layer.h)) / 2)} onChange={(radius) => onPatch({ radius } as Partial<Layer>, 'radius')} />}
    </div>
  );
}

/* ---------------- Adjustments ---------------- */
export interface AdjustState {
  adj: Adjustments;
  filter: FilterName;
  strength: number;
  compare: boolean;
  split: number;
}

export const NO_ADJUST_STATE: AdjustState = { adj: NO_ADJUST, filter: 'none', strength: 60, compare: false, split: 0.5 };

export function isAdjusted(s: AdjustState): boolean {
  return s.filter !== 'none' || Object.values(s.adj).some((v) => v !== 0);
}

export function AdjustPanel({ state, onChange, onApply, onReset, enabled, busy }: { state: AdjustState; onChange: (s: AdjustState) => void; onApply: () => void; onReset: () => void; enabled: boolean; busy: boolean }) {
  const a = state.adj;
  const set = (patch: Partial<Adjustments>) => onChange({ ...state, adj: { ...a, ...patch } });
  if (!enabled) return <div className="muted" style={{ fontSize: 13 }}>Select a pixel layer (paint or image) to adjust colours and apply filters. Text and shapes can be rasterized first.</div>;
  const changed = isAdjusted(state);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Range label="Brightness" value={a.brightness} min={-100} max={100} onChange={(brightness) => set({ brightness })} />
      <Range label="Contrast" value={a.contrast} min={-100} max={100} onChange={(contrast) => set({ contrast })} />
      <Range label="Saturation" value={a.saturation} min={-100} max={100} onChange={(saturation) => set({ saturation })} />
      <Range label="Exposure" value={a.exposure} min={-2} max={2} step={0.05} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(exposure) => set({ exposure })} />
      <Range label="Vibrance" value={a.vibrance} min={-100} max={100} onChange={(vibrance) => set({ vibrance })} />
      <Range label="Temperature" value={a.temperature} min={-100} max={100} onChange={(temperature) => set({ temperature })} />
      <Range label="Hue" value={a.hue} min={-180} max={180} format={(v) => `${v}°`} onChange={(hue) => set({ hue })} />
      <Range label="Transparency" value={a.alpha} min={-100} max={100} format={(v) => (v < 0 ? `${-v}% more transparent` : v > 0 ? `${v}% more opaque` : '0')} onChange={(alpha) => set({ alpha })} />
      <div className="field">
        <label htmlFor="filter-select">Filter</label>
        <select id="filter-select" className="input sm" value={state.filter} onChange={(e) => onChange({ ...state, filter: e.target.value as FilterName })}>
          {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>
      {state.filter !== 'none' && <Range label="Strength" value={state.strength} min={1} max={100} onChange={(strength) => onChange({ ...state, strength })} />}
      <label className="check"><input type="checkbox" checked={state.compare} disabled={!changed} onChange={(e) => onChange({ ...state, compare: e.target.checked })} /> Before / after split view</label>
      {state.compare && changed && <Range label="Split position" value={Math.round(state.split * 100)} min={0} max={100} format={(v) => `${v}%`} onChange={(v) => onChange({ ...state, split: v / 100 })} />}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!changed || busy} onClick={onApply} data-testid="apply-adjust">{busy ? <span className="spinner" /> : <Icon name="check" size={14} />} Apply</button>
        <button className="btn sm" disabled={!changed} onClick={onReset}>Reset</button>
      </div>
    </div>
  );
}

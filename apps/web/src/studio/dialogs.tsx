import { useEffect, useMemo, useState } from 'react';
import { compressionStats, formatBytes } from '@smg/codec';
import { Icon } from '../components/Icon.tsx';
import { DEFAULT_SETTINGS, SmgSettings, toEncodeOptions, type SmgSettingsValue } from '../components/SmgSettings.tsx';
import { Modal, Progress, Range, Segmented } from '../components/ui.tsx';
import { CancelledError } from '../lib/codec-client.ts';
import { saveBlob } from '../lib/download.ts';
import { canEncode, cleanError, EXPORT_EXT, EXPORT_LABELS, EXPORT_MIME, exportImage, type ExportFormat } from '../lib/images.ts';
import type { Doc } from './model.ts';
import type { ProjectRecord } from './project.ts';
import { docThumb, flatten } from './render.ts';
import { SIZE_PRESETS, TEMPLATES } from './templates.ts';

/* ---------------- New document ---------------- */
export function NewDocDialog({ open, onClose, onCreate, onTemplate, recent, onOpenRecent, onDeleteRecent, onOpenFile }: {
  open: boolean;
  onClose: () => void;
  onCreate: (w: number, h: number, bg: string | null, name: string) => void;
  onTemplate: (id: string) => void;
  recent: ProjectRecord[];
  onOpenRecent: (id: string) => void;
  onDeleteRecent: (id: string) => void;
  onOpenFile: () => void;
}) {
  const [tab, setTab] = useState<'size' | 'templates' | 'recent'>('size');
  const [w, setW] = useState(1080);
  const [h, setH] = useState(1080);
  const [bg, setBg] = useState<'white' | 'transparent' | 'color'>('white');
  const [color, setColor] = useState('#0b1020');
  const [name, setName] = useState('Untitled');
  const groups = useMemo(() => [...new Set(SIZE_PRESETS.map((p) => p.group))], []);
  useEffect(() => {
    if (open && recent.length && tab === 'size') setTab('size');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = w >= 1 && h >= 1 && w <= 8192 && h <= 8192;
  return (
    <Modal open={open} onClose={onClose} title="New design" wide>
      <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Segmented value={tab} onChange={setTab} ariaLabel="New document source" options={[{ value: 'size', label: 'Blank canvas' }, { value: 'templates', label: 'Templates' }, { value: 'recent', label: `Recent (${recent.length})` }]} />
        <span className="spacer" />
        <button className="btn sm" onClick={onOpenFile}><Icon name="folder" size={14} /> Open file…</button>
      </div>
      {tab === 'size' && (
        <div className="stack" style={{ gap: 16 }}>
          {groups.map((g) => (
            <div key={g}>
              <div className="label" style={{ marginBottom: 8 }}>{g}</div>
              <div className="preset-grid">
                {SIZE_PRESETS.filter((p) => p.group === g).map((p) => (
                  <button key={p.id} className={`preset${p.width === w && p.height === h ? ' on' : ''}`} onClick={() => { setW(p.width); setH(p.height); setName(p.label); }}>
                    <span className="ratio" style={{ aspectRatio: `${p.width} / ${p.height}` }} />
                    <span className="pl">{p.label}</span>
                    <span className="ps mono">{p.width}×{p.height}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 110 }}><label htmlFor="nd-w">Width</label><input id="nd-w" className="input" type="number" min={1} max={8192} value={w} onChange={(e) => setW(Number(e.target.value))} /></div>
            <div className="field" style={{ width: 110 }}><label htmlFor="nd-h">Height</label><input id="nd-h" className="input" type="number" min={1} max={8192} value={h} onChange={(e) => setH(Number(e.target.value))} /></div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}><label htmlFor="nd-name">Name</label><input id="nd-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <Segmented value={bg} onChange={setBg} ariaLabel="Background" options={[{ value: 'white', label: 'White' }, { value: 'transparent', label: 'Transparent' }, { value: 'color', label: 'Colour' }]} />
            {bg === 'color' && <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Background colour" />}
            <span className="spacer" />
            {!valid && <span className="err" style={{ fontSize: 13 }}>Sizes must be 1–8192 px.</span>}
            <button className="btn primary" disabled={!valid} onClick={() => onCreate(Math.round(w), Math.round(h), bg === 'white' ? '#ffffff' : bg === 'transparent' ? null : color, name || 'Untitled')} data-testid="create-doc">
              Create {w}×{h}
            </button>
          </div>
        </div>
      )}
      {tab === 'templates' && (
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="template" onClick={() => onTemplate(t.id)}>
              <TemplatePreview id={t.id} />
              <span className="pl">{t.label}</span>
              <span className="ps">{t.description} · {t.width}×{t.height}</span>
            </button>
          ))}
        </div>
      )}
      {tab === 'recent' && (
        recent.length === 0 ? (
          <div className="empty">No projects saved in this browser yet. Studio autosaves your work locally while you edit.</div>
        ) : (
          <div className="template-grid">
            {recent.map((r) => (
              <div key={r.id} className="template" role="button" tabIndex={0} onClick={() => onOpenRecent(r.id)} onKeyDown={(e) => e.key === 'Enter' && onOpenRecent(r.id)}>
                <img src={r.thumb} alt="" className="checker" style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'contain', borderRadius: 10 }} />
                <span className="pl">{r.name}</span>
                <span className="ps">{r.width}×{r.height} · {new Date(r.updatedAt).toLocaleString()}</span>
                <button className="btn sm ghost danger" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); onDeleteRecent(r.id); }}><Icon name="trash" size={13} /> Delete</button>
              </div>
            ))}
          </div>
        )
      )}
    </Modal>
  );
}

const previewCache = new Map<string, string>();
function TemplatePreview({ id }: { id: string }) {
  const [src, setSrc] = useState(previewCache.get(id) ?? '');
  useEffect(() => {
    if (previewCache.has(id)) return;
    const t = TEMPLATES.find((x) => x.id === id)!;
    // Render after fonts load so previews use the right typefaces.
    document.fonts.ready.then(() => {
      const url = docThumb(t.build(), 320);
      previewCache.set(id, url);
      setSrc(url);
    });
  }, [id]);
  return src ? <img src={src} alt="" className="checker" style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'contain', borderRadius: 10 }} /> : <div className="checker" style={{ width: '100%', aspectRatio: '16 / 10', borderRadius: 10 }} />;
}

/* ---------------- Export ---------------- */
export function ExportDialog({ open, onClose, doc }: { open: boolean; onClose: () => void; doc: Doc }) {
  const [format, setFormat] = useState<ExportFormat>('smg');
  const [quality, setQuality] = useState(90);
  const [smg, setSmg] = useState<SmgSettingsValue>({ ...DEFAULT_SETTINGS, preset: 'illustration', mode: 'auto', quality: 88, effort: 6 });
  const [bg, setBg] = useState(true);
  const [support, setSupport] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<{ p: number; stage: string; ctrl: AbortController } | null>(null);
  const [result, setResult] = useState<{ bytes: number; name: string; codec?: string; exact?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    (async () => {
      const s: Record<string, boolean> = {};
      for (const f of ['jpeg', 'webp'] as const) s[f] = await canEncode(EXPORT_MIME[f]);
      setSupport(s);
    })();
  }, [open]);
  const raw = doc.width * doc.height * 4;
  const go = async () => {
    const ctrl = new AbortController();
    setBusy({ p: 0, stage: 'Rendering', ctrl });
    setError(null);
    setResult(null);
    try {
      const img = flatten(doc, bg || format === 'jpeg');
      const r = await exportImage(img, format, { quality, smg: toEncodeOptions(smg), metadata: smg.stripMetadata ? undefined : { text: { Title: doc.name, Software: 'SMG Studio', Created: new Date(doc.createdAt).toISOString() } }, signal: ctrl.signal, onProgress: (p, stage) => setBusy((b) => (b ? { ...b, p, stage } : b)) });
      const name = `${doc.name.replace(/[\\/:*?"<>|]+/g, '-') || 'design'}${EXPORT_EXT[format]}`;
      saveBlob(r.blob, name);
      setResult({ bytes: r.bytes, name, codec: r.smg?.info.codecName, exact: r.smg?.info.exact });
    } catch (e) {
      if (!(e instanceof CancelledError)) setError(cleanError(e));
    } finally {
      setBusy(null);
    }
  };
  const stats = result ? compressionStats(raw, result.bytes, doc.width * doc.height) : null;
  return (
    <Modal open={open} onClose={() => { busy?.ctrl.abort(); onClose(); }} title="Export image">
      <div className="stack" style={{ gap: 16 }}>
        <div className="field">
          <span className="label">Format</span>
          <Segmented value={format} onChange={setFormat} ariaLabel="Export format" options={(['smg', 'png', 'jpeg', 'webp'] as ExportFormat[]).map((f) => ({ value: f, label: <span style={{ opacity: support[f] === false ? 0.4 : 1 }}>{EXPORT_LABELS[f]}</span> }))} />
          {support[format] === false && <span className="err" style={{ fontSize: 12.5 }}>This browser cannot encode {EXPORT_LABELS[format]}.</span>}
        </div>
        {format === 'smg' && <SmgSettings value={smg} onChange={setSmg} compact />}
        {(format === 'jpeg' || format === 'webp') && <Range label="Quality" value={quality} min={1} max={100} onChange={setQuality} />}
        <label className="check">
          <input type="checkbox" checked={bg || format === 'jpeg'} disabled={format === 'jpeg' || !doc.background} onChange={(e) => setBg(e.target.checked)} /> Include background {doc.background ? `(${doc.background})` : '(canvas is transparent)'}
        </label>
        <div className="muted" style={{ fontSize: 13 }}>Flattened {doc.width}×{doc.height} image · raw size {formatBytes(raw)}. Your editable project is kept separately (File → Save project).</div>
        {busy && (
          <div className="stack" style={{ gap: 6 }}>
            <Progress value={busy.p} />
            <span className="muted" style={{ fontSize: 12.5 }}>{busy.stage}</span>
          </div>
        )}
        {result && stats && (
          <div className="notice ok" data-testid="export-result">
            Saved <b>{result.name}</b> — {formatBytes(result.bytes)} ({stats.bitsPerPixel!.toFixed(2)} bpp, {stats.reductionPercent.toFixed(1)}% smaller than raw RGBA){result.codec ? ` · ${result.codec}${result.exact ? ' · bit-exact' : ''}` : ''}
          </div>
        )}
        {error && <div className="notice">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {busy ? (
            <button className="btn" onClick={() => busy.ctrl.abort()}>Cancel</button>
          ) : (
            <button className="btn primary" onClick={go} disabled={support[format] === false} data-testid="do-export">
              <Icon name="download" size={16} /> Export {EXPORT_LABELS[format]}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Resize / canvas size ---------------- */
export function ResizeDialog({ open, onClose, doc, mode, onApply }: { open: boolean; onClose: () => void; doc: Doc; mode: 'image' | 'canvas'; onApply: (w: number, h: number, anchor: [number, number]) => void }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [lock, setLock] = useState(true);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  useEffect(() => {
    if (open) {
      setW(doc.width);
      setH(doc.height);
    }
  }, [open, doc.width, doc.height]);
  const ratio = doc.width / doc.height;
  const valid = w >= 1 && h >= 1 && w <= 8192 && h <= 8192;
  return (
    <Modal open={open} onClose={onClose} title={mode === 'image' ? 'Resize image' : 'Canvas size'}>
      <div className="stack" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>{mode === 'image' ? 'Scales every layer (pixels are resampled; text and shapes stay sharp).' : 'Changes the canvas without scaling content. Choose where existing content is anchored.'}</p>
        <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 120 }}><label htmlFor="rs-w">Width</label><input id="rs-w" className="input" type="number" value={w} onChange={(e) => { const v = Number(e.target.value); setW(v); if (lock) setH(Math.max(1, Math.round(v / ratio))); }} /></div>
          <div className="field" style={{ width: 120 }}><label htmlFor="rs-h">Height</label><input id="rs-h" className="input" type="number" value={h} onChange={(e) => { const v = Number(e.target.value); setH(v); if (lock) setW(Math.max(1, Math.round(v * ratio))); }} /></div>
          <label className="check"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep aspect ratio</label>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {[25, 50, 200].map((p) => <button key={p} className="btn sm" onClick={() => { setW(Math.round((doc.width * p) / 100)); setH(Math.round((doc.height * p) / 100)); }}>{p}%</button>)}
        </div>
        {mode === 'canvas' && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Anchor</div>
            <div className="anchor-grid">
              {[0, 0.5, 1].flatMap((ay) => [0, 0.5, 1].map((ax) => (
                <button key={`${ax}-${ay}`} className={anchor[0] === ax && anchor[1] === ay ? 'on' : ''} onClick={() => setAnchor([ax, ay])} aria-label={`Anchor ${ax},${ay}`} />
              )))}
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={!valid} onClick={() => { onApply(Math.round(w), Math.round(h), anchor); onClose(); }}>Apply {w}×{h}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Shortcuts ---------------- */
export const SHORTCUTS: Array<[string, string]> = [
  ['V', 'Move / select'], ['H or hold Space', 'Pan'], ['B', 'Brush'], ['P', 'Pencil'], ['E', 'Eraser'], ['G', 'Fill bucket'],
  ['U', 'Rectangle'], ['O', 'Ellipse'], ['L', 'Line'], ['A', 'Arrow'], ['T', 'Text'], ['I', 'Eyedropper'], ['C', 'Crop'],
  ['[ / ]', 'Brush size'], ['X', 'Swap colours'], ['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
  ['Ctrl+S', 'Save project file'], ['Ctrl+E', 'Export'], ['Ctrl+N', 'New design'], ['Ctrl+O', 'Open'],
  ['Ctrl+D', 'Duplicate layer'], ['Ctrl+Shift+N', 'New layer'], ['Delete', 'Delete layer'], ['Ctrl+[ / Ctrl+]', 'Send backward / bring forward'],
  ['Arrows (+Shift)', 'Nudge 1 px (10 px)'], ['Ctrl+= / Ctrl+-', 'Zoom in / out'], ['Ctrl+0', 'Fit to screen'], ['Ctrl+1', 'Actual pixels'],
  ["'", 'Toggle grid'], ['Enter / Esc', 'Apply / cancel crop'], ['Ctrl+wheel', 'Zoom at cursor'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" wide>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{v}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { compressionStats, formatBytes, type SmgInfo } from '@smg/codec';
import { createZip } from '@smg/codec/io';
import { Icon } from '../components/Icon.tsx';
import { makeThumb } from '../components/ImageView.tsx';
import { SmgInspector } from '../components/SmgInspector.tsx';
import { DEFAULT_SETTINGS, SmgSettings, toEncodeOptions, type SmgSettingsValue } from '../components/SmgSettings.tsx';
import { Dropzone, Modal, Progress, Range, Segmented, useToast } from '../components/ui.tsx';
import { CancelledError, codec } from '../lib/codec-client.ts';
import { saveBlob } from '../lib/download.ts';
import { getPref, setPref } from '../lib/idb.ts';
import { canEncode, cleanError, EXPORT_EXT, EXPORT_LABELS, EXPORT_MIME, exportImage, loadFile, rasterizeSvg, replaceExt, svgIntrinsicSize, type ExportFormat, type Img, type LoadedFile } from '../lib/images.ts';
import './tool.css';

interface Output {
  name: string;
  blob: Blob;
  bytes: number;
  frame: number;
  dupOf?: string;
}

interface Item {
  id: string;
  file: File;
  status: 'loading' | 'ready' | 'converting' | 'done' | 'error';
  loaded?: LoadedFile;
  thumb?: string;
  hashes?: string[];
  svgSize?: { width: number; height: number };
  svgText?: string;
  outputs: Output[];
  progress: number;
  error?: string;
}

const FORMATS: ExportFormat[] = ['smg', 'png', 'jpeg', 'webp', 'avif', 'bmp'];

export default function Convert() {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [target, setTarget] = useState<ExportFormat>('smg');
  const [quality, setQuality] = useState(85);
  const [allFrames, setAllFrames] = useState(true);
  const [smg, setSmg] = useState<SmgSettingsValue>(DEFAULT_SETTINGS);
  const [support, setSupport] = useState<Record<string, boolean>>({ smg: true, png: true, bmp: true, jpeg: true });
  const [running, setRunning] = useState(false);
  const [inspect, setInspect] = useState<{ name: string; info: SmgInfo } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      const s: Record<string, boolean> = { smg: true, png: true, bmp: true };
      for (const f of ['jpeg', 'webp', 'avif'] as const) s[f] = await canEncode(EXPORT_MIME[f]);
      setSupport(s);
    })();
    getPref<SmgSettingsValue>('convert.smg', DEFAULT_SETTINGS).then((v) => setSmg({ ...DEFAULT_SETTINGS, ...v }));
    getPref<ExportFormat>('convert.target', 'smg').then(setTarget);
  }, []);

  const update = (id: string, patch: Partial<Item> | ((i: Item) => Partial<Item>)) =>
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...(typeof patch === 'function' ? patch(i) : patch) } : i)));

  const load = useCallback(async (item: Item, svgSize?: { width: number; height: number }) => {
    try {
      const loaded = await loadFile(item.file, { svgSize });
      const hashes = await Promise.all(loaded.frames.map((f) => codec.hash(f)));
      let svgText: string | undefined;
      let size = svgSize;
      if (loaded.format === 'svg') {
        svgText = await item.file.text();
        size = size ?? svgIntrinsicSize(svgText);
      }
      update(item.id, { status: 'ready', loaded, hashes, thumb: makeThumb(loaded.frames[0]), svgSize: size, svgText, outputs: [], error: undefined });
    } catch (e) {
      update(item.id, { status: 'error', error: cleanError(e) });
    }
  }, []);

  const onFiles = useCallback(
    (files: File[]) => {
      const fresh: Item[] = files.map((file) => ({ id: `${file.name}-${Math.random().toString(36).slice(2)}`, file, status: 'loading', outputs: [], progress: 0 }));
      setItems((l) => [...l, ...fresh]);
      fresh.forEach((it) => load(it));
    },
    [load],
  );

  const rerenderSvg = async (it: Item, size: { width: number; height: number }) => {
    if (!it.svgText || !it.loaded) return;
    try {
      const img = await rasterizeSvg(it.svgText, size.width, size.height);
      const hash = await codec.hash(img);
      update(it.id, { loaded: { ...it.loaded, frames: [img], notes: [`SVG rasterised at ${img.width}×${img.height}.`] }, hashes: [hash], svgSize: size, outputs: [], status: 'ready', thumb: makeThumb(img) });
    } catch (e) {
      toast(cleanError(e), 'error');
    }
  };

  const convertAll = async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setRunning(true);
    const seen = new Map<string, Output & { src: string }>(); // pixel hash → output (duplicate detection)
    try {
      for (const it of items) {
        if (c.signal.aborted) break;
        if (!it.loaded || it.status === 'error' || it.status === 'loading') continue;
        update(it.id, { status: 'converting', progress: 0, outputs: [] });
        const frames = allFrames ? it.loaded.frames : it.loaded.frames.slice(0, 1);
        const outputs: Output[] = [];
        try {
          for (let f = 0; f < frames.length; f++) {
            const suffix = frames.length > 1 ? `-frame-${String(f + 1).padStart(3, '0')}` : '';
            const name = replaceExt(it.file.name, '') + suffix + EXPORT_EXT[target];
            const hash = it.hashes?.[f];
            const dup = hash ? seen.get(hash) : undefined;
            if (dup) {
              outputs.push({ ...dup, name, frame: f, dupOf: dup.src });
              continue;
            }
            const r = await exportImage(frames[f] as Img, target, {
              quality,
              smg: toEncodeOptions(smg),
              metadata: smg.stripMetadata ? undefined : it.loaded.metadata,
              signal: c.signal,
              onProgress: (p) => update(it.id, { progress: (f + p) / frames.length }),
            });
            const out: Output = { name, blob: r.blob, bytes: r.bytes, frame: f };
            outputs.push(out);
            if (hash) seen.set(hash, { ...out, src: name });
            update(it.id, { progress: (f + 1) / frames.length, outputs: [...outputs] });
          }
          update(it.id, { status: 'done', outputs, progress: 1 });
        } catch (e) {
          if (e instanceof CancelledError) {
            update(it.id, { status: 'ready', progress: 0 });
            break;
          }
          update(it.id, { status: 'error', error: cleanError(e) });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const downloadAll = () => {
    const outs = items.flatMap((i) => i.outputs);
    if (!outs.length) return;
    if (outs.length === 1) return saveBlob(outs[0].blob, outs[0].name);
    Promise.all(outs.map(async (o) => ({ name: o.name, data: new Uint8Array(await o.blob.arrayBuffer()) }))).then((entries) => {
      saveBlob(new Blob([createZip(entries) as BlobPart], { type: 'application/zip' }), `smg-converted-${target}.zip`);
    });
  };

  const openInspector = async (it: Item) => {
    try {
      const info = it.loaded?.smgInfo ?? (await codec.inspect(new Uint8Array(await it.file.arrayBuffer())));
      setInspect({ name: it.file.name, info });
    } catch (e) {
      toast(cleanError(e), 'error');
    }
  };

  const outCount = items.reduce((s, i) => s + i.outputs.length, 0);
  const totalIn = items.filter((i) => i.outputs.length).reduce((s, i) => s + i.file.size, 0);
  const totalOut = items.reduce((s, i) => s + i.outputs.reduce((a, o) => a + o.bytes, 0), 0);
  const ready = items.some((i) => i.status === 'ready' || i.status === 'done');

  return (
    <div className="container" style={{ paddingBottom: 60 }}>
      <div className="page-head" style={{ paddingBottom: 20 }}>
        <div className="eyebrow">Converter</div>
        <h1>Convert to and from SMG</h1>
        <p className="lead">Batch-convert PNG, JPEG, WebP, AVIF, BMP, GIF and SVG to SMG — or turn .smg files back into conventional formats. Drop files to inspect them; nothing leaves your browser.</p>
      </div>

      <div className="card toolbar-card" style={{ marginBottom: 18 }}>
        <div className="field" style={{ minWidth: 0 }}>
          <span className="label">Convert to</span>
          <Segmented
            value={target}
            ariaLabel="Target format"
            onChange={(f) => {
              if (!support[f]) {
                toast(`${EXPORT_LABELS[f]} export is not supported by this browser.`, 'error');
                return;
              }
              setTarget(f);
              setPref('convert.target', f);
            }}
            options={FORMATS.map((f) => ({ value: f, label: <span style={{ opacity: support[f] === false ? 0.4 : 1 }}>{EXPORT_LABELS[f]}</span>, title: support[f] === false ? 'Not supported by this browser' : undefined }))}
          />
        </div>
        {(target === 'jpeg' || target === 'webp' || target === 'avif') && (
          <div style={{ width: 220 }}>
            <Range label={`${EXPORT_LABELS[target]} quality`} value={quality} min={1} max={100} onChange={setQuality} />
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={allFrames} onChange={(e) => setAllFrames(e.target.checked)} /> Extract every GIF frame
        </label>
      </div>

      <div className="tool-layout">
        <div className="stack" style={{ gap: 14 }}>
          <Dropzone onFiles={onFiles} accept="image/*,.smg,.svg" compact={items.length > 0} />
          {items.map((it) => {
            const l = it.loaded;
            const first = l?.frames[0];
            const outBytes = it.outputs.reduce((s, o) => s + o.bytes, 0);
            const st = it.outputs.length && it.outputs.length === (allFrames ? l?.frames.length : 1) ? compressionStats(it.file.size, outBytes) : null;
            return (
              <div key={it.id} className="file-row" data-testid="file-row">
                {it.thumb ? <img className="thumb" src={it.thumb} alt="" /> : <div className="thumb" style={{ display: 'grid', placeItems: 'center' }}>{it.status === 'loading' ? <span className="spinner" /> : <Icon name="image" />}</div>}
                <div style={{ minWidth: 0 }}>
                  <div className="name">{it.file.name}</div>
                  <div className="meta">
                    {l && <span className="badge">{l.formatLabel}</span>}
                    {first && <span>{first.width}×{first.height}</span>}
                    <span>{formatBytes(it.file.size)}</span>
                    {l && l.frames.length > 1 && <span>{l.frames.length} frames</span>}
                    {l?.smgInfo && <span>{l.smgInfo.codecName.split(' (')[0]} · {l.smgInfo.exact ? 'lossless' : 'lossy'}</span>}
                    {st && (
                      <span className={st.reductionPercent >= 0 ? 'ok' : 'warn'} data-testid="row-result">
                        → {formatBytes(outBytes)} ({st.reductionPercent >= 0 ? '−' : '+'}{Math.abs(st.reductionPercent).toFixed(0)}%)
                      </span>
                    )}
                    {it.outputs.some((o) => o.dupOf) && <span className="warn">duplicate pixels reused</span>}
                    {it.status === 'error' && <span className="err">{it.error}</span>}
                  </div>
                  {l?.format === 'svg' && it.svgSize && (
                    <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                      <span className="muted" style={{ fontSize: 12.5 }}>Rasterise at</span>
                      <input className="input sm" type="number" min={1} max={8192} style={{ width: 84 }} defaultValue={it.svgSize.width} aria-label="SVG width" onBlur={(e) => rerenderSvg(it, { width: Number(e.target.value) || 1, height: it.svgSize!.height })} />
                      <span className="muted">×</span>
                      <input className="input sm" type="number" min={1} max={8192} style={{ width: 84 }} defaultValue={it.svgSize.height} aria-label="SVG height" onBlur={(e) => rerenderSvg(it, { width: it.svgSize!.width, height: Number(e.target.value) || 1 })} />
                      <span className="muted" style={{ fontSize: 12 }}>px</span>
                    </div>
                  )}
                  {it.status === 'converting' && (
                    <div style={{ marginTop: 8 }}>
                      <Progress value={it.progress} />
                    </div>
                  )}
                </div>
                <div className="actions">
                  {l?.format === 'smg' && (
                    <button className="btn sm" onClick={() => openInspector(it)}>
                      <Icon name="info" size={14} /> Inspect
                    </button>
                  )}
                  {it.outputs.length === 1 && (
                    <button className="btn sm primary" onClick={() => saveBlob(it.outputs[0].blob, it.outputs[0].name)} data-testid="row-download">
                      <Icon name="download" size={14} /> {EXPORT_LABELS[(Object.entries(EXPORT_EXT).find(([, e]) => it.outputs[0].name.endsWith(e))?.[0] ?? 'smg') as ExportFormat]}
                    </button>
                  )}
                  {it.outputs.length > 1 && (
                    <button className="btn sm primary" onClick={() => Promise.all(it.outputs.map(async (o) => ({ name: o.name, data: new Uint8Array(await o.blob.arrayBuffer()) }))).then((e) => saveBlob(new Blob([createZip(e) as BlobPart], { type: 'application/zip' }), replaceExt(it.file.name, '-frames.zip')))}>
                      <Icon name="download" size={14} /> ZIP ({it.outputs.length})
                    </button>
                  )}
                  <button className="btn icon sm ghost" aria-label="Remove" onClick={() => setItems((l2) => l2.filter((x) => x.id !== it.id))}>
                    <Icon name="x" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <aside className="side-panel stack" style={{ gap: 16 }}>
          {target === 'smg' && (
            <div className="card">
              <h3 style={{ marginBottom: 16 }}>SMG settings</h3>
              <SmgSettings value={smg} onChange={(v) => { setSmg(v); setPref('convert.smg', v); }} compact />
            </div>
          )}
          <div className="card stack" style={{ gap: 12 }}>
            {running ? (
              <button className="btn" onClick={() => abortRef.current?.abort()}>
                <Icon name="stop" size={14} /> Cancel
              </button>
            ) : (
              <button className="btn primary" disabled={!ready} onClick={convertAll} data-testid="convert-btn">
                <Icon name="convert" size={16} /> Convert {items.length > 1 ? `all (${items.length})` : ''} to {EXPORT_LABELS[target]}
              </button>
            )}
            <button className="btn" disabled={!outCount} onClick={downloadAll}>
              <Icon name="download" size={16} /> {outCount > 1 ? `Download all as ZIP (${outCount})` : 'Download'}
            </button>
            <button className="btn ghost" disabled={!items.length || running} onClick={() => setItems([])}>
              Clear list
            </button>
            {outCount > 0 && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Total: {formatBytes(totalIn)} → {formatBytes(totalOut)} ({totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(0) : 0}% {totalOut <= totalIn ? 'saved' : 'larger'})
              </div>
            )}
          </div>
          <div className="notice info">Lossless SMG output is verified bit-exact against the decoded input by a stored CRC-32. JPEG, WebP and AVIF use your browser’s encoders.</div>
        </aside>
      </div>
      <Modal open={!!inspect} onClose={() => setInspect(null)} title={inspect ? `Inspect · ${inspect.name}` : ''} wide>
        {inspect && <SmgInspector info={inspect.info} />}
      </Modal>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compressionStats, formatBytes, type EncodeInfo } from '@smg/codec';
import { createZip } from '@smg/codec/io';
import { Icon } from '../components/Icon.tsx';
import { CompareSlider, makeThumb } from '../components/ImageView.tsx';
import { DEFAULT_SETTINGS, SmgSettings, toEncodeOptions, type SmgSettingsValue } from '../components/SmgSettings.tsx';
import { Dropzone, Progress, useToast } from '../components/ui.tsx';
import { CancelledError, codec } from '../lib/codec-client.ts';
import { saveBlob, saveBytes } from '../lib/download.ts';
import { getPref, setPref } from '../lib/idb.ts';
import { cleanError, loadFile, replaceExt, type Img, type LoadedFile } from '../lib/images.ts';
import './tool.css';

interface Result {
  bytes: Uint8Array;
  info: EncodeInfo;
  metrics?: { psnr: number; ssim: number };
  decoded: Img;
  ms: number;
  settingsKey: string;
}

interface Item {
  id: string;
  loaded: LoadedFile;
  image: Img;
  thumb: string;
  hash: string;
  dupOf?: string;
  status: 'idle' | 'working' | 'done' | 'error';
  progress: number;
  stage: string;
  error?: string;
  result?: Result;
}

const fmtDb = (v: number) => (v === Infinity ? '∞' : `${v.toFixed(2)} dB`);

export default function Compress() {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<SmgSettingsValue>(DEFAULT_SETTINGS);
  const [estimate, setEstimate] = useState<{ bytes: number; sampled: boolean; key: string } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [loading, setLoading] = useState(0);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const estAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    getPref<SmgSettingsValue>('compress.settings', DEFAULT_SETTINGS).then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s }));
  }, []);
  const changeSettings = (s: SmgSettingsValue) => {
    setSettings(s);
    setPref('compress.settings', s);
  };

  const active = items.find((i) => i.id === activeId) ?? null;
  const settingsKey = JSON.stringify(settings);
  const update = (id: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const onFiles = useCallback(
    async (files: File[]) => {
      setLoading((n) => n + files.length);
      for (const f of files) {
        try {
          const loaded = await loadFile(f);
          const image = loaded.frames[0];
          const hash = await codec.hash(image);
          const item: Item = { id: loaded.id, loaded, image, thumb: makeThumb(image), hash, status: 'idle', progress: 0, stage: '' };
          setItems((list) => {
            const dup = list.find((x) => x.hash === hash);
            return [...list, dup ? { ...item, dupOf: dup.loaded.name } : item];
          });
          setActiveId((cur) => cur ?? item.id);
          if (loaded.frames.length > 1) toast(`${f.name}: using the first of ${loaded.frames.length} frames (use the converter to extract all).`);
        } catch (e) {
          toast(`${f.name}: ${cleanError(e)}`, 'error');
        } finally {
          setLoading((n) => n - 1);
        }
      }
    },
    [toast],
  );

  // ---- live estimate (debounced, cancellable) ----
  useEffect(() => {
    if (!active) {
      setEstimate(null);
      return;
    }
    const key = `${active.id}|${settingsKey}`;
    const t = setTimeout(async () => {
      estAbort.current?.abort();
      const c = new AbortController();
      estAbort.current = c;
      setEstimating(true);
      try {
        const img = active.image;
        const px = img.width * img.height;
        const opts = { ...toEncodeOptions(settings), effort: Math.min(settings.effort, 3) };
        let sample: Img = img;
        let sampled = false;
        if (px > 1_000_000) {
          const s = Math.sqrt(600_000 / px);
          sample = await codec.resize(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
          sampled = true;
        }
        if (opts.targetSize && sampled) opts.targetSize = Math.round(opts.targetSize * ((sample.width * sample.height) / px));
        const r = await codec.encode(sample, opts, { signal: c.signal });
        const bytes = sampled ? Math.round(r.bytes.length * (px / (sample.width * sample.height))) : r.bytes.length;
        setEstimate({ bytes, sampled, key });
      } catch (e) {
        if (!(e instanceof CancelledError)) setEstimate(null);
      } finally {
        if (estAbort.current === c) setEstimating(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [active?.id, settingsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const compressOne = async (item: Item, signal: AbortSignal, reuse?: Result): Promise<Result> => {
    if (reuse) return reuse;
    update(item.id, { status: 'working', progress: 0, stage: 'Starting', error: undefined });
    const t0 = performance.now();
    const r = await codec.encode(item.image, { ...toEncodeOptions(settings), metadata: item.loaded.metadata }, {
      signal,
      withMetrics: true,
      onProgress: (p, stage) => update(item.id, { progress: p, stage }),
    });
    const ms = performance.now() - t0;
    const dec = await codec.decode(r.bytes, undefined, { signal });
    return { bytes: r.bytes, info: r.info, metrics: r.metrics, decoded: dec.image, ms, settingsKey };
  };

  const run = async (targets: Item[]) => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setBatch({ done: 0, total: targets.length });
    const byHash = new Map<string, Result>();
    for (const it of items) if (it.result && it.result.settingsKey === settingsKey) byHash.set(it.hash, it.result);
    let done = 0;
    for (const it of targets) {
      if (c.signal.aborted) break;
      try {
        const result = await compressOne(it, c.signal, byHash.get(it.hash));
        byHash.set(it.hash, result);
        update(it.id, { status: 'done', progress: 1, result, stage: '' });
      } catch (e) {
        if (e instanceof CancelledError) {
          update(it.id, { status: 'idle', progress: 0, stage: '' });
          break;
        }
        update(it.id, { status: 'error', error: cleanError(e) });
        toast(`${it.loaded.name}: ${cleanError(e)}`, 'error');
      }
      setBatch({ done: ++done, total: targets.length });
    }
    setBatch(null);
  };

  const cancel = () => {
    abortRef.current?.abort();
    setBatch(null);
  };

  const downloadActive = () => {
    if (!active?.result) return;
    saveBytes(active.result.bytes, replaceExt(active.loaded.name, '.smg'), 'image/x-smg');
  };

  const downloadAll = () => {
    const done = items.filter((i) => i.result);
    if (!done.length) return;
    const zip = createZip(done.map((i) => ({ name: replaceExt(i.loaded.name, '.smg'), data: i.result!.bytes })));
    saveBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), 'smg-compressed.zip');
  };

  const remove = (id: string) => {
    setItems((l) => l.filter((i) => i.id !== id));
    if (activeId === id) setActiveId(items.find((i) => i.id !== id)?.id ?? null);
  };

  const res = active?.result;
  const stale = res && res.settingsKey !== settingsKey;
  const stats = res && active ? compressionStats(active.loaded.bytes, res.bytes.length, active.image.width * active.image.height) : null;
  const totals = useMemo(() => {
    const done = items.filter((i) => i.result);
    const orig = done.reduce((s, i) => s + i.loaded.bytes, 0);
    const out = done.reduce((s, i) => s + i.result!.bytes.length, 0);
    return { n: done.length, orig, out };
  }, [items]);
  const working = batch !== null;

  return (
    <div className="container wide" style={{ paddingBottom: 60 }}>
      <div className="page-head" style={{ paddingBottom: 20 }}>
        <div className="eyebrow">Compressor</div>
        <h1>Compress images to SMG</h1>
        <p className="lead">Pick a preset or tune quality, effort and a target size. Everything is encoded on your device; the numbers below are measured from the actual output.</p>
      </div>

      <div className="tool-layout">
        <div className="stack" style={{ gap: 16 }}>
          {items.length === 0 ? (
            <Dropzone onFiles={onFiles} accept="image/*,.smg,.svg" />
          ) : (
            <>
              <div className="card pad-s">
                <div className="row" style={{ alignItems: 'stretch' }}>
                  <div className="strip" style={{ flex: 1 }}>
                    {items.map((i) => (
                      <div key={i.id} className={`strip-item${i.id === activeId ? ' on' : ''}`} onClick={() => setActiveId(i.id)} title={i.loaded.name}>
                        <img src={i.thumb} alt="" />
                        {i.status === 'done' && <span className="st">✓</span>}
                        {i.status === 'error' && <span className="st err">!</span>}
                        <div className="nm">{i.loaded.name}</div>
                      </div>
                    ))}
                  </div>
                  <Dropzone onFiles={onFiles} accept="image/*,.smg,.svg" compact>
                    <div className="stack" style={{ alignItems: 'center', gap: 4, justifyContent: 'center', height: '100%' }}>
                      <Icon name="plus" />
                      <span style={{ fontSize: 12 }}>Add</span>
                    </div>
                  </Dropzone>
                </div>
              </div>
              {active && (
                <div className="card pad-s">
                  <div className="row between wrap" style={{ marginBottom: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.loaded.name}</div>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {active.loaded.formatLabel} · {active.image.width}×{active.image.height} · {formatBytes(active.loaded.bytes)}
                        {active.dupOf && <span className="warn"> · duplicate of {active.dupOf}</span>}
                      </div>
                    </div>
                    <button className="btn sm ghost danger" onClick={() => remove(active.id)}>
                      <Icon name="trash" size={15} /> Remove
                    </button>
                  </div>
                  <CompareSlider before={active.image} after={res?.decoded ?? null} afterLabel={res ? `SMG · ${formatBytes(res.bytes.length)}` : 'SMG'} beforeLabel={`${active.loaded.formatLabel} · ${formatBytes(active.loaded.bytes)}`} height="min(62vh, 560px)" />
                  {active.loaded.notes.map((n) => (
                    <div key={n} className="notice info" style={{ marginTop: 10 }}>
                      {n}
                    </div>
                  ))}
                </div>
              )}
              {active && res && stats && (
                <div className="card fade-in" data-testid="results">
                  <div className="row between wrap" style={{ marginBottom: 16 }}>
                    <h3 style={{ margin: 0 }}>Results {stale && <span className="badge warn" style={{ marginLeft: 8 }}>settings changed — compress again to update</span>}</h3>
                    <div className="row">
                      <span className={`badge ${res.info.exact ? 'ok' : res.info.visuallyLossless ? 'brand' : 'warn'}`}>{res.info.exact ? 'Lossless · bit-exact' : res.info.visuallyLossless ? 'Visually lossless' : 'Lossy'}</span>
                    </div>
                  </div>
                  <div className="results-grid">
                    <div className="stat"><span className="k">Original</span><span className="v mono">{formatBytes(stats.originalBytes)}</span></div>
                    <div className="stat"><span className="k">SMG</span><span className="v mono gradient-text" data-testid="smg-size">{formatBytes(stats.compressedBytes)}</span></div>
                    <div className="stat"><span className="k">Bytes saved</span><span className={`v mono ${stats.savedBytes >= 0 ? 'ok' : 'err'}`}>{formatBytes(stats.savedBytes)}</span></div>
                    <div className="stat"><span className="k">Reduction</span><span className={`v mono ${stats.reductionPercent >= 0 ? 'ok' : 'err'}`}>{stats.reductionPercent.toFixed(1)}%</span></div>
                    <div className="stat"><span className="k">Dimensions</span><span className="v mono">{res.info.width}×{res.info.height}</span></div>
                    <div className="stat"><span className="k">Codec</span><span className="v" style={{ fontSize: '1rem' }}>{res.info.codecName}</span></div>
                    <div className="stat"><span className="k">Quality</span><span className="v mono">{res.info.quality ?? (res.info.exact ? 'exact' : '—')}</span></div>
                    <div className="stat"><span className="k">Bits / pixel</span><span className="v mono">{stats.bitsPerPixel!.toFixed(2)}</span></div>
                    <div className="stat"><span className="k">PSNR</span><span className="v mono">{res.info.exact ? '∞' : res.metrics ? fmtDb(res.metrics.psnr) : '—'}</span></div>
                    <div className="stat"><span className="k">SSIM</span><span className="v mono">{res.info.exact ? '1.0000' : res.metrics ? res.metrics.ssim.toFixed(4) : '—'}</span></div>
                    <div className="stat"><span className="k">Colour model</span><span className="v" style={{ fontSize: '1rem' }}>{res.info.colorModelName}</span></div>
                    <div className="stat"><span className="k">Time</span><span className="v mono">{(res.ms / 1000).toFixed(2)} s</span></div>
                  </div>
                  <div className="savings-bar" style={{ marginTop: 18 }} title={`${stats.reductionPercent.toFixed(1)}% smaller`}>
                    <i style={{ width: `${Math.min(100, (stats.compressedBytes / stats.originalBytes) * 100)}%` }} />
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    Original: {formatBytes(stats.originalBytes)} · SMG: {formatBytes(stats.compressedBytes)} · {stats.reductionPercent >= 0 ? `Space saved: ${stats.reductionPercent.toFixed(0)}%` : `Larger than the original by ${(-stats.reductionPercent).toFixed(0)}% — the source was already very compact`}
                    {res.info.targetSize !== null && <> · Target {formatBytes(res.info.targetSize)}: {res.info.targetMet ? 'met' : 'not reachable — smallest output shown'}</>}
                  </p>
                  {res.info.candidates.length > 1 && (
                    <div className="table-wrap" style={{ marginTop: 14 }}>
                      <table className="data">
                        <thead>
                          <tr><th>Candidate encoding</th><th className="num">Size</th><th>Fidelity</th><th className="num">Time</th></tr>
                        </thead>
                        <tbody>
                          {res.info.candidates.map((c) => (
                            <tr key={c.label} className={c.chosen ? 'best' : ''}>
                              <td>{c.chosen ? '✓ ' : ''}{c.label}</td>
                              <td className="num">{formatBytes(c.bytes)}</td>
                              <td>{c.exact ? 'exact' : c.quality !== null ? `lossy q${c.quality}` : 'quantised'}</td>
                              <td className="num">{c.timeMs} ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {loading > 0 && (
            <div className="row muted">
              <span className="spinner" /> Reading {loading} file{loading > 1 ? 's' : ''}…
            </div>
          )}
        </div>

        <aside className="side-panel stack" style={{ gap: 16 }}>
          <div className="card">
            <h3 style={{ marginBottom: 16 }}>Settings</h3>
            <SmgSettings value={settings} onChange={changeSettings} />
          </div>
          <div className="card stack" style={{ gap: 12 }}>
            <div className="row between">
              <span className="label" style={{ margin: 0 }}>Estimated size</span>
              {estimating && <span className="spinner" />}
            </div>
            <div className="mono" style={{ font: '650 1.6rem var(--font-display)' }} data-testid="estimate">
              {estimate && active ? `≈ ${formatBytes(estimate.bytes)}` : '—'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {estimate?.sampled ? 'Fast estimate from a downscaled sample; the final size is measured after compression.' : 'Fast estimate (effort ≤ 3); the final size is measured after compression.'}
            </div>
            {working && batch ? (
              <>
                <Progress value={active?.status === 'working' ? active.progress : batch.done / batch.total} />
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {active?.stage || 'Working'} · {batch.done}/{batch.total}
                </div>
                <button className="btn" onClick={cancel}>
                  <Icon name="stop" size={14} /> Cancel
                </button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={!active} onClick={() => active && run([active])} data-testid="compress-btn">
                  <Icon name="compress" size={16} /> Compress
                </button>
                {items.length > 1 && (
                  <button className="btn" onClick={() => run(items)}>
                    Compress all ({items.length})
                  </button>
                )}
              </>
            )}
            <button className="btn" disabled={!res} onClick={downloadActive} data-testid="download-btn">
              <Icon name="download" size={16} /> Download .smg
            </button>
            {totals.n > 1 && (
              <button className="btn" onClick={downloadAll}>
                <Icon name="download" size={16} /> Download all as ZIP ({formatBytes(totals.out)})
              </button>
            )}
            {totals.n > 0 && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                {totals.n} compressed · {formatBytes(totals.orig)} → {formatBytes(totals.out)} ({((1 - totals.out / totals.orig) * 100).toFixed(0)}% saved)
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes, type RgbaImage } from '@smg/codec';
import { BarChart } from '../components/BarChart.tsx';
import { Icon } from '../components/Icon.tsx';
import { Dropzone, Progress, Range, useToast } from '../components/ui.tsx';
import { bench, fmtPct, losslessDelta, lossyDelta, type ImageResult } from '../data/bench.ts';
import { codec } from '../lib/codec-client.ts';
import { canEncode, cleanError, decodeNative, imageToCanvas, loadFile, type Img } from '../lib/images.ts';
import './benchmarks.css';

const CATEGORIES: Array<{ id: string; label: string; match: (im: ImageResult) => boolean }> = [
  { id: 'photo', label: 'Photographs', match: (im) => im.category === 'photo' },
  { id: 'screenshot', label: 'Screenshots', match: (im) => im.category === 'screenshot' },
  { id: 'graphic', label: 'Logos, icons & illustrations', match: (im) => ['logo', 'icon', 'illustration'].includes(im.category) },
  { id: 'gradient', label: 'Gradients', match: (im) => im.category === 'gradient' },
];

const kb = (b: number) => (b >= 100_000 ? `${(b / 1000).toFixed(0)} KB` : `${(b / 1000).toFixed(1)} KB`);
const LL = ['smg', 'png', 'webp', 'avif'];
const LY = ['smg', 'jpeg', 'webp', 'avif'];
const NAME: Record<string, string> = { smg: 'SMG', png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF' };

function sumLossless(codecName: string, f: (im: ImageResult) => boolean) {
  return bench.images.filter(f).reduce((s, im) => s + (im.lossless[codecName]?.bytes ?? 0), 0);
}

/** Lossy totals over images where *every* listed codec reached the SSIM target (fair comparison set). */
function sumLossy(f: (im: ImageResult) => boolean, codecs: string[]) {
  const set = bench.images.filter((im) => f(im) && codecs.every((c) => im.lossy.results[c]?.bytes && im.lossy.results[c].reachedTarget !== false));
  const totals: Record<string, number> = {};
  for (const c of codecs) totals[c] = set.reduce((s, im) => s + im.lossy.results[c].bytes, 0);
  return { totals, n: set.length };
}

export default function Benchmarks() {
  const ll = useMemo(() => CATEGORIES.map((c) => ({ ...c, n: bench.images.filter(c.match).length, totals: Object.fromEntries(LL.map((k) => [k, sumLossless(k, c.match)])) })), []);
  const ly = useMemo(() => CATEGORIES.map((c) => ({ ...c, ...sumLossy(c.match, ['smg', 'webp', 'avif']), jpeg: sumLossy(c.match, ['smg', 'jpeg']) })), []);
  const m = bench.machine;
  const v = bench.versions;
  return (
    <div className="container" style={{ paddingBottom: 60 }}>
      <div className="page-head">
        <div className="eyebrow">Benchmarks</div>
        <h1>Measured, not marketed</h1>
        <p className="lead">
          SMG compared with PNG, JPEG, WebP and AVIF on a {bench.images.length}-image corpus of photographs, screenshots, logos, icons, illustrations and gradients. Every number below comes from <code>bench/results/latest.json</code>, produced by <code>npm run bench</code>.
        </p>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 28 }}>
        {[
          { v: fmtPct(lossyDelta('jpeg').delta), k: `vs JPEG at equal SSIM`, s: `${lossyDelta('jpeg').images} opaque images` },
          { v: fmtPct(lossyDelta('webp').delta), k: 'vs WebP at equal SSIM', s: `${lossyDelta('webp').images} images` },
          { v: fmtPct(lossyDelta('avif').delta), k: 'vs AVIF at equal SSIM', s: `${lossyDelta('avif').images} images — AVIF wins` },
          { v: fmtPct(losslessDelta('webp')), k: 'lossless vs WebP lossless', s: `all ${bench.images.length} images, bit-exact` },
        ].map((x) => (
          <div key={x.k} className="card pad-s stat">
            <span className="k">{x.k}</span>
            <span className="v big">{x.v}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>{x.s}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Negative = SMG files are smaller. Sizes are summed over the images in each comparison set.</p>

      <section className="section-tight">
        <h2>Lossless</h2>
        <p>Every codec encodes the same RGBA pixels at its strongest practical setting. Outputs are decoded again and compared pixel by pixel; all results below were verified bit-exact{Object.values(bench.summary.lossless).every((s) => s.exactAll) ? '' : ' (except where marked ≠)'}.</p>
        <div className="grid grid-2" style={{ marginTop: 18 }}>
          {ll.map((c) => (
            <div className="card pad-s" key={c.id}>
              <BarChart
                title={`${c.label} · ${c.n} image${c.n === 1 ? '' : 's'}`}
                format={kb}
                bars={LL.map((k) => ({ label: NAME[k], value: c.totals[k], highlight: k === 'smg' }))}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <h2>Lossy at equal visual quality</h2>
        <p>
          SMG encodes each image in <em>auto</em> mode at quality {bench.images[0]?.lossy.smgQuality}. Its SSIM becomes the target, capped at 0.995. For every other codec a binary search over its quality setting finds the <strong>smallest file that reaches the same SSIM</strong>. The bars compare totals over images where all compared codecs reached the target. JPEG is shown separately because it cannot store transparency.
        </p>
        <div className="grid grid-2" style={{ marginTop: 18 }}>
          {ly.map((c) => (
            <div className="card pad-s" key={c.id}>
              <BarChart
                title={`${c.label} · ${c.n} image${c.n === 1 ? '' : 's'}`}
                format={kb}
                bars={[
                  { label: 'SMG', value: c.n ? c.totals.smg : null, highlight: true },
                  { label: 'WebP', value: c.n ? c.totals.webp : null },
                  { label: 'AVIF', value: c.n ? c.totals.avif : null },
                  { label: 'JPEG', value: c.jpeg.n ? c.jpeg.totals.jpeg : null, note: c.jpeg.n ? `${c.jpeg.n} opaque image${c.jpeg.n === 1 ? '' : 's'}; SMG ${kb(c.jpeg.totals.smg)} on the same set` : 'no alpha support' },
                ]}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <h2>Per image</h2>
        <h3 style={{ marginTop: 20 }}>Lossless (smallest in bold)</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Image</th><th>Size</th>
                {LL.map((k) => <th key={k} className="num">{NAME[k]}</th>)}
                <th className="num">SMG enc / dec</th>
              </tr>
            </thead>
            <tbody>
              {bench.images.map((im) => {
                const best = Math.min(...LL.map((k) => im.lossless[k]?.bytes ?? Infinity));
                return (
                  <tr key={im.file}>
                    <td>{im.file}</td>
                    <td className="muted">{im.width}×{im.height}{im.hasAlpha ? ' · α' : ''}</td>
                    {LL.map((k) => {
                      const r = im.lossless[k];
                      return <td key={k} className={`num${r?.bytes === best ? ' win' : ''}`} title={r?.note}>{r ? kb(r.bytes) : '—'}{r && !r.exact ? ' ≠' : ''}</td>;
                    })}
                    <td className="num muted">{Math.round(im.lossless.smg.encodeMs)} / {Math.round(im.lossless.smg.decodeMs)} ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: 28 }}>Lossy at equal SSIM (quality setting in brackets)</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Image</th><th className="num">Target SSIM</th>
                {LY.map((k) => <th key={k} className="num">{NAME[k]}</th>)}
                <th>SMG codec</th>
              </tr>
            </thead>
            <tbody>
              {bench.images.map((im) => {
                const vals = LY.map((k) => im.lossy.results[k]).filter((r) => r?.bytes && r.reachedTarget !== false).map((r) => r!.bytes);
                const best = Math.min(...vals);
                return (
                  <tr key={im.file}>
                    <td>{im.file}</td>
                    <td className="num">{im.lossy.targetSsim.toFixed(4)}</td>
                    {LY.map((k) => {
                      const r = im.lossy.results[k];
                      if (!r || !r.bytes) return <td key={k} className="num dim" title={r?.note}>—</td>;
                      return (
                        <td key={k} className={`num${r.bytes === best && r.reachedTarget !== false ? ' win' : ''}`} title={`SSIM ${r.ssim?.toFixed(4)} · PSNR ${r.psnr === Infinity ? '∞' : r.psnr?.toFixed(2)} dB`}>
                          {kb(r.bytes)} <span className="dim">[{k === 'smg' ? (r.exact ? 'exact' : r.quality ?? '–') : r.quality}]</span>{r.reachedTarget === false ? '*' : ''}
                        </td>
                      );
                    })}
                    <td className="muted">{im.lossy.results.smg.note?.split(' (')[0]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>* target SSIM not reached even at quality 100 (excluded from totals). — = format cannot store alpha. Hover a cell for its SSIM and PSNR.</p>
      </section>

      <section className="section-tight grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>Methodology &amp; environment</h3>
          <dl className="kv">
            <dt>Generated</dt><dd>{new Date(bench.generatedAt).toLocaleString()}</dd>
            <dt>Tool</dt><dd>{bench.tool}</dd>
            <dt>CPU</dt><dd>{m.cpu} ({m.cores} cores)</dd>
            <dt>Memory</dt><dd>{m.memoryGB} GB</dd>
            <dt>OS / runtime</dt><dd>{m.os} · Node {m.node}</dd>
            <dt>libvips</dt><dd>{v.vips} (sharp {v.sharp})</dd>
            <dt>Encoders</dt><dd>libpng {v.png} · mozjpeg {v.mozjpeg} · libwebp {v.webp} · libheif {v.heif} + aom {v.aom}</dd>
          </dl>
          <div className="divider-line" />
          <dl className="kv">
            {Object.entries(bench.settings).map(([k, s]) => (
              <span key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd style={{ fontFamily: 'var(--font-ui)' }}>{s}</dd></span>
            ))}
          </dl>
        </div>
        <div className="card">
          <h3>Limitations — read these</h3>
          <ul className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0, color: 'var(--text-2)' }}>
            <li>The corpus is small ({bench.images.length} images) and was assembled for this project. Results on your images will differ; run the live test below or <code>smg benchmark</code> on your own files.</li>
            <li>SSIM measures structural similarity of luma only. Equal SSIM is not identical perceived quality, and other metrics (Butteraugli, SSIMULACRA 2) may rank codecs differently.</li>
            <li>AVIF produces smaller files than SMG at equal SSIM on this corpus, especially on graphics and screenshots.</li>
            <li>WebP lossless beats SMG lossless on some screenshots and logos; SMG wins on photos, gradients, icons and the corpus total.</li>
            <li>Timings compare single-threaded JavaScript (SMG) with native C libraries; SMG is slower to encode and decode.</li>
            <li>“auto” mode may choose a lossless or palette encoding for graphics, so SMG’s SSIM there can be 1.0 (target capped at 0.995).</li>
          </ul>
          <div className="divider-line" />
          <h3>Reproduce</h3>
          <pre className="mono" style={{ margin: 0, background: '#090b16', padding: 14, borderRadius: 12, overflowX: 'auto', fontSize: 13 }}>
{`git clone <repo> && cd SMG-Image-File
npm install
npm run build -w @smg/cli
npm run bench   # writes bench/results/latest.{json,md}`}
          </pre>
        </div>
      </section>

      <LiveBenchmark />
    </div>
  );
}

/* ---------------- live in-browser benchmark ---------------- */
interface LiveRow {
  name: string;
  bytes: number | null;
  ms: number | null;
  psnr: number | null;
  ssim: number | null;
  note?: string;
}

const SAMPLES = [
  { file: 'cat.png', label: 'Photo (cat)' },
  { file: 'coffee.png', label: 'Photo (coffee)' },
  { file: 'dashboard.png', label: 'Screenshot' },
  { file: 'badge.png', label: 'Logo (alpha)' },
  { file: 'landscape.png', label: 'Illustration' },
];

function LiveBenchmark() {
  const toast = useToast();
  const [img, setImg] = useState<{ image: Img; name: string } | null>(null);
  const [quality, setQuality] = useState(80);
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const loadSample = async (file: string) => {
    try {
      const res = await fetch(`/samples/${file}`);
      const f = new File([await res.blob()], file, { type: 'image/png' });
      const l = await loadFile(f);
      setImg({ image: l.frames[0], name: file });
      setRows([]);
    } catch (e) {
      toast(cleanError(e), 'error');
    }
  };

  useEffect(() => {
    loadSample('cat.png');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!img) return;
    abort.current?.abort();
    const c = new AbortController();
    abort.current = c;
    setRunning(true);
    setRows([]);
    const out: LiveRow[] = [];
    const push = (r: LiveRow) => {
      out.push(r);
      setRows([...out]);
    };
    const tasks: Array<[string, () => Promise<{ bytes: number; ms: number; decoded: RgbaImage | null; exact?: boolean; note?: string }>]> = [
      ['SMG (auto)', async () => {
        const t = performance.now();
        const r = await codec.encode(img.image, { mode: 'auto', quality }, { signal: c.signal });
        const ms = performance.now() - t;
        const d = await codec.decode(r.bytes, undefined, { signal: c.signal });
        return { bytes: r.bytes.length, ms, decoded: d.image, exact: r.info.exact, note: r.info.codecName.split(' (')[0] };
      }],
      ['SMG (lossless)', async () => {
        const t = performance.now();
        const r = await codec.encode(img.image, { mode: 'lossless', effort: 5 }, { signal: c.signal });
        return { bytes: r.bytes.length, ms: performance.now() - t, decoded: null, exact: true, note: 'bit-exact' };
      }],
    ];
    for (const [name, mime, q] of [['PNG (browser)', 'image/png', 1], ['JPEG (browser)', 'image/jpeg', quality], ['WebP (browser)', 'image/webp', quality], ['AVIF (browser)', 'image/avif', quality]] as const) {
      tasks.push([name, async () => {
        if (!(await canEncode(mime))) return { bytes: -1, ms: 0, decoded: null, note: 'not supported by this browser' };
        const canvas = imageToCanvas(img.image, mime === 'image/jpeg' ? '#ffffff' : undefined);
        const t = performance.now();
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, q === 1 ? undefined : q / 100));
        const ms = performance.now() - t;
        if (!blob) return { bytes: -1, ms: 0, decoded: null, note: 'encoding failed' };
        const decoded = mime === 'image/png' ? null : await decodeNative(blob);
        return { bytes: blob.size, ms, decoded, exact: mime === 'image/png', note: mime === 'image/png' ? 'lossless' : `quality ${quality}` };
      }]);
    }
    try {
      for (let i = 0; i < tasks.length; i++) {
        if (c.signal.aborted) break;
        setProgress(i / tasks.length);
        const [name, fn] = tasks[i];
        const r = await fn();
        if (r.bytes < 0) {
          push({ name, bytes: null, ms: null, psnr: null, ssim: null, note: r.note });
          continue;
        }
        let psnrV: number | null = r.exact ? Infinity : null, ssimV: number | null = r.exact ? 1 : null;
        if (r.decoded && !r.exact) {
          const mt = await codec.metrics(img.image, r.decoded);
          psnrV = mt.psnr;
          ssimV = mt.ssim;
        }
        push({ name, bytes: r.bytes, ms: r.ms, psnr: psnrV, ssim: ssimV, note: r.note });
      }
    } catch (e) {
      toast(cleanError(e), 'error');
    } finally {
      setProgress(1);
      setRunning(false);
    }
  };

  const best = Math.min(...rows.filter((r) => r.bytes).map((r) => r.bytes!));
  return (
    <section className="section-tight" id="live">
      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Run it in your browser</h2>
            <p style={{ margin: 0 }}>Compares SMG with the encoders built into <em>your</em> browser (which differ from the reference libraries above). Nothing is uploaded.</p>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
          {SAMPLES.map((s) => (
            <button key={s.file} className={`btn sm${img?.name === s.file ? ' active' : ''}`} onClick={() => loadSample(s.file)}>{s.label}</button>
          ))}
        </div>
        <Dropzone onFiles={async (f) => { try { const l = await loadFile(f[0]); setImg({ image: l.frames[0], name: f[0].name }); setRows([]); } catch (e) { toast(cleanError(e), 'error'); } }} multiple={false} compact>
          <span className="muted"><Icon name="upload" size={15} style={{ display: 'inline', verticalAlign: '-3px' }} /> Or drop your own image</span>
        </Dropzone>
        <div className="row wrap" style={{ gap: 20, marginTop: 16, alignItems: 'flex-end' }}>
          <div style={{ width: 240 }}><Range label="Lossy quality" value={quality} min={1} max={100} onChange={setQuality} /></div>
          <span className="muted" style={{ fontSize: 13 }}>{img ? `${img.name} · ${img.image.width}×${img.image.height}` : 'Loading sample…'}</span>
          <span className="spacer" />
          {running ? <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button> : <button className="btn primary" disabled={!img} onClick={run} data-testid="run-live"><Icon name="play" size={14} /> Run benchmark</button>}
        </div>
        {running && <div style={{ marginTop: 12 }}><Progress value={progress} /></div>}
        {rows.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data" data-testid="live-results">
              <thead><tr><th>Encoder</th><th className="num">Size</th><th className="num">Encode</th><th className="num">PSNR</th><th className="num">SSIM</th><th>Notes</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td className={`num${r.bytes === best ? ' win' : ''}`}>{r.bytes !== null ? formatBytes(r.bytes) : '—'}</td>
                    <td className="num">{r.ms !== null ? `${r.ms.toFixed(0)} ms` : '—'}</td>
                    <td className="num">{r.psnr === null ? '—' : r.psnr === Infinity ? '∞' : `${r.psnr.toFixed(2)} dB`}</td>
                    <td className="num">{r.ssim === null ? '—' : r.ssim.toFixed(4)}</td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Lossy codecs are run at the same nominal quality, which does not mean equal visual quality — compare sizes together with PSNR/SSIM. Browser timings include canvas overhead.</p>
      </div>
    </section>
  );
}

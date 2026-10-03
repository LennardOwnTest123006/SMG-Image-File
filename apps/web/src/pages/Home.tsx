import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes, compressionStats, type RgbaImage } from '@smg/codec';
import { Icon, type IconName } from '../components/Icon.tsx';
import { CompareSlider } from '../components/ImageView.tsx';
import { LogoMark, Range, Segmented } from '../components/ui.tsx';
import { codec, CancelledError } from '../lib/codec-client.ts';
import { bench, fmtPct, losslessDelta, lossyDelta } from '../data/bench.ts';
import './home.css';

type Img = RgbaImage & { data: Uint8Array };

/* ---------------- Live hero demo ---------------- */
function LiveDemo() {
  const [src, setSrc] = useState<{ img: Img; pngBytes: number } | null>(null);
  const [out, setOut] = useState<{ img: Img; bytes: number; codec: string; ms: number } | null>(null);
  const [quality, setQuality] = useState(70);
  const [mode, setMode] = useState<'lossy' | 'lossless'>('lossy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/samples/cat.png');
        const bytes = new Uint8Array(await res.arrayBuffer());
        const r = await codec.decodeFile(bytes, 40e6);
        const f = r.frames[0];
        if (alive) setSrc({ img: { width: f.width, height: f.height, data: new Uint8Array(f.data) }, pngBytes: bytes.length });
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!src) return;
    const t = setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setBusy(true);
      try {
        const t0 = performance.now();
        const enc = await codec.encode(src.img, mode === 'lossless' ? { mode: 'lossless', effort: 4 } : { mode: 'lossy', quality }, { signal: c.signal });
        const ms = performance.now() - t0;
        const dec = await codec.decode(enc.bytes, undefined, { signal: c.signal });
        setOut({ img: dec.image, bytes: enc.bytes.length, codec: enc.info.codecName, ms });
        setError(null);
      } catch (e) {
        if (!(e instanceof CancelledError)) setError((e as Error).message);
      } finally {
        if (ctrl.current === c) setBusy(false);
      }
    }, 140);
    return () => clearTimeout(t);
  }, [src, quality, mode]);

  const stats = src && out ? compressionStats(src.pngBytes, out.bytes) : null;
  return (
    <div className="demo-card reveal d2" aria-label="Live compression demo">
      <div className="demo-top">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
          Live demo · real encoding in your browser
        </span>
        <span className="spacer" />
        {busy && <span className="spinner" aria-label="Encoding" />}
      </div>
      {src ? (
        <CompareSlider before={src.img} after={out?.img ?? null} beforeLabel={`PNG · ${formatBytes(src.pngBytes)}`} afterLabel={out ? `SMG · ${formatBytes(out.bytes)}` : 'SMG'} height="clamp(220px, 34vw, 330px)" />
      ) : (
        <div className="compare checker" style={{ height: 300, display: 'grid', placeItems: 'center' }}>
          {error ? <span className="err">{error}</span> : <span className="spinner" />}
        </div>
      )}
      <div className="demo-controls">
        <Range label="Quality" value={quality} min={10} max={98} onChange={setQuality} disabled={mode === 'lossless'} format={(v) => (mode === 'lossless' ? 'exact' : v)} />
        <Segmented
          value={mode}
          onChange={setMode}
          ariaLabel="Mode"
          options={[
            { value: 'lossy', label: 'Lossy' },
            { value: 'lossless', label: 'Lossless' },
          ]}
        />
      </div>
      <div className="demo-stats">
        <div className="stat">
          <span className="k">Original PNG</span>
          <span className="v mono">{src ? formatBytes(src.pngBytes) : '—'}</span>
        </div>
        <div className="stat">
          <span className="k">SMG</span>
          <span className="v mono gradient-text">{out ? formatBytes(out.bytes) : '—'}</span>
        </div>
        <div className="stat">
          <span className="k">Space saved</span>
          <span className="v mono ok">{stats ? `${stats.reductionPercent.toFixed(0)}%` : '—'}</span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, padding: '6px 6px 2px' }}>
        Photo: “Chelsea” (CC0) · {src ? `${src.img.width}×${src.img.height}` : ''} {out ? `· ${out.codec} · encoded in ${out.ms.toFixed(0)} ms` : ''}
      </div>
    </div>
  );
}

/* ---------------- Draw pad (interactive Studio preview) ---------------- */
function DrawPad() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState('#6a5cff');
  const [size, setSize] = useState<{ bytes: number; codec: string } | null>(null);
  const drawing = useRef(false);
  const last = useRef<[number, number] | null>(null);
  const timer = useRef<number>(0);

  const measure = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const c = ref.current;
      if (!c) return;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      const r = await codec.encode({ width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) }, { mode: 'auto', effort: 3 });
      setSize({ bytes: r.bytes.length, codec: r.info.codecName.split(' ')[0] });
    }, 250);
  }, []);

  const reset = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#3d7bff');
    g.addColorStop(1, '#a855f7');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(40, 40, 120, 120, 28);
    ctx.fill();
    ctx.fillStyle = '#14162b';
    ctx.font = 'bold 54px "Space Grotesk Variable", sans-serif';
    ctx.fillText('Hello SMG', 190, 122);
    measure();
  }, [measure]);

  useEffect(() => {
    reset();
  }, [reset]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };

  return (
    <div className="stack">
      <canvas
        ref={ref}
        width={640}
        height={400}
        className="pad"
        aria-label="Drawing pad"
        onPointerDown={(e) => {
          drawing.current = true;
          last.current = pos(e);
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = pos(e);
          const ctx = ref.current!.getContext('2d')!;
          ctx.strokeStyle = color;
          ctx.lineWidth = 10;
          ctx.lineCap = ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(...last.current!);
          ctx.lineTo(...p);
          ctx.stroke();
          last.current = p;
        }}
        onPointerUp={() => {
          drawing.current = false;
          measure();
        }}
      />
      <div className="row between wrap">
        <div className="swatches">
          {['#6a5cff', '#3d7bff', '#ec4899', '#10b981', '#f59e0b', '#14162b'].map((c) => (
            <button key={c} className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
          ))}
        </div>
        <div className="row">
          <span className="badge brand mono">{size ? `${formatBytes(size.bytes)} · ${size.codec}` : 'measuring…'}</span>
          <button className="btn sm" onClick={reset}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */
const FEATURES: Array<{ id: string; icon: IconName; title: string; to: string; cta: string; points: string[] }> = [
  { id: 'studio', icon: 'brush', title: 'SMG Studio', to: '/studio', cta: 'Open Studio', points: ['Layers with opacity, visibility & ordering', 'Brush, pencil, eraser, fill, shapes, arrows, text', 'Adjustments, filters & before/after view', 'Templates for logos, thumbnails, banners & posters', 'Autosave & recovery — all on your device'] },
  { id: 'convert', icon: 'convert', title: 'Converter', to: '/convert', cta: 'Convert images', points: ['PNG, JPEG, WebP, BMP, GIF frames, SVG → SMG', 'SMG → PNG, JPEG, WebP, BMP (and AVIF where supported)', 'Batch processing with ZIP download', 'Inspect SMG headers, chunks & metadata', 'Duplicate detection by pixel hash'] },
  { id: 'compress', icon: 'compress', title: 'Compressor', to: '/compress', cta: 'Compress images', points: ['Presets for photos, screenshots, logos & UI', 'Quality, effort & exact target file size', 'Live size estimate before export', 'Before/after slider with PSNR & SSIM', 'Automatic comparison of candidate encodings'] },
  { id: 'dev', icon: 'terminal', title: 'Developer tools', to: '/docs', cta: 'Read the docs', points: ['smg encode · decode · info · benchmark', 'TypeScript library (52 KB, zero dependencies)', 'Documented binary specification', 'Reproducible benchmark suite', 'MIT licensed'] },
];

export default function Home() {
  const [tab, setTab] = useState('studio');
  const f = FEATURES.find((x) => x.id === tab)!;
  const isPhoto = (im: { category: string }) => im.category === 'photo';
  const llPhotoWebp = losslessDelta('webp', isPhoto);
  const llPng = losslessDelta('png');
  const lyJpeg = lyDeltaSafe('jpeg');
  const lyWebp = lyDeltaSafe('webp');
  const lyAvif = lyDeltaSafe('avif');

  return (
    <>
      <section className="hero">
        <div className="bg-grid" />
        <div className="orb a" />
        <div className="orb b" />
        <div className="container wide hero-grid">
          <div>
            <div className="hero-mark reveal">
              <LogoMark size={26} />
              <span>
                <b>SMG 1.0</b> · an open image format with its own codecs
              </span>
            </div>
            <h1 className="reveal d1">
              <span className="line">Images.</span>
              <span className="line gradient-text">Smaller.</span>
              <span className="line">Smarter.</span>
            </h1>
            <p className="lead reveal d2">
              SMG is a new image format with original lossless, palette and wavelet codecs — and a complete image studio, converter and compressor that run entirely in your browser. Nothing is uploaded.
            </p>
            <div className="row wrap reveal d3" style={{ gap: 12, marginTop: 28 }}>
              <Link to="/studio" className="btn primary lg">
                <Icon name="brush" /> Open SMG Studio
              </Link>
              <Link to="/convert" className="btn lg">
                <Icon name="convert" /> Convert images
              </Link>
            </div>
            <div className="hero-badges reveal d4">
              <span className="badge ok"><Icon name="lock" size={13} /> 100% local processing</span>
              <span className="badge"><Icon name="bolt" size={13} /> Web Workers</span>
              <span className="badge"><Icon name="code" size={13} /> Open spec · MIT</span>
            </div>
          </div>
          <LiveDemo />
        </div>
      </section>

      <section className="section-tight">
        <div className="container">
          <div className="metric-strip">
            <div>
              <div className="v gradient-text">{fmtPct(lyJpeg.delta)}</div>
              <div className="k">file size vs JPEG at equal SSIM ({lyJpeg.images} images)</div>
            </div>
            <div>
              <div className="v gradient-text">{fmtPct(lyWebp.delta)}</div>
              <div className="k">file size vs WebP at equal SSIM ({lyWebp.images} images)</div>
            </div>
            <div>
              <div className="v gradient-text">{fmtPct(llPng)}</div>
              <div className="k">lossless vs optimised PNG (all {bench.images.length} images)</div>
            </div>
            <div>
              <div className="v gradient-text">{fmtPct(llPhotoWebp)}</div>
              <div className="k">lossless photos vs WebP lossless</div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
            Measured on the {bench.images.length}-image SMG corpus ({new Date(bench.generatedAt).toLocaleDateString()}). SMG is not best everywhere: at equal SSIM, SMG files are {lyAvif.delta >= 0 ? `${lyAvif.delta.toFixed(1)}% larger` : `${(-lyAvif.delta).toFixed(1)}% smaller`} than AVIF on this corpus.{' '}
            <Link to="/benchmarks" style={{ color: '#a5b4fc' }}>
              See every number and how it was measured →
            </Link>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="eyebrow">One ecosystem</div>
          <h2>Create, convert and compress — in one place</h2>
          <p className="lead">Every tool runs on the same open SMG codec library, compiled into this page and executed in background threads on your device.</p>
          <div className="tabs-bar" role="tablist" style={{ marginTop: 28 }}>
            {FEATURES.map((x) => (
              <button key={x.id} role="tab" aria-selected={tab === x.id} className={`tab-btn${tab === x.id ? ' on' : ''}`} onClick={() => setTab(x.id)}>
                <Icon name={x.icon} size={16} /> {x.title}
              </button>
            ))}
          </div>
          <div className="card preview-panel">
            <div>
              <h3 style={{ fontSize: '1.6rem' }}>{f.title}</h3>
              <ul className="feature-list">
                {f.points.map((p) => (
                  <li key={p}>
                    <Icon name="check" size={16} /> {p}
                  </li>
                ))}
              </ul>
              <Link to={f.to} className="btn primary">
                {f.cta} <Icon name="chevronRight" size={16} />
              </Link>
            </div>
            <div>
              {tab === 'studio' && (
                <>
                  <DrawPad />
                  <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Draw something — the badge shows the real size of this canvas as an .smg file.</p>
                </>
              )}
              {tab === 'convert' && <ConvertPreview />}
              {tab === 'compress' && <CompressPreview />}
              {tab === 'dev' && (
                <pre className="card pad-s mono" style={{ margin: 0, fontSize: 13, lineHeight: 1.7, overflowX: 'auto', background: '#090b16' }}>
{`$ smg encode photo-coffee.png -q 80
photo-coffee.png → photo-coffee.smg
  600×400 · SMG-W (wavelet lossy) · RGB · quality 80 · lossy
  Original: 625 KB · SMG: 48.0 KB · Space saved: 92% (1.60 bpp)

import { encode, decode } from '@smg/codec';
const { bytes, info } = encode(imageData, { preset: 'photo' });
const { image } = decode(bytes);`}
                </pre>
              )}
            </div>
          </div>
          {tab === 'dev' && <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Real CLI output for a benchmark-corpus photo (timing omitted; it depends on your machine).</p>}
        </div>
      </section>

      <section className="section" style={{ paddingTop: 24 }}>
        <div className="container">
          <div className="eyebrow">Inside the format</div>
          <h2>Three codecs, one tiny container</h2>
          <p className="lead">The encoder analyses each image, tries the codecs that fit, and keeps the smallest result that meets your quality target. Every choice is reported — never guessed.</p>
          <div className="grid grid-3" style={{ marginTop: 32 }}>
            <div className="card codec-card hover">
              <div className="card-icon"><Icon name="layers" /></div>
              <h3>SMG-L · Lossless</h3>
              <p>Eight spatial predictors chosen per tile, a blended predictor, bias cancellation and context-modelled residuals. LZ77 pixel copies and a colour cache capture repeated UI and text.</p>
              <div className="tag-row"><span className="badge ok">bit-exact</span><span className="badge">photos</span><span className="badge">screenshots</span></div>
            </div>
            <div className="card codec-card hover">
              <div className="card-icon"><Icon name="palette" /></div>
              <h3>SMG-P · Palette</h3>
              <p>Up to 256 colours with alpha, coded by neighbour matches and transition contexts. Optional quantisation (median cut + k-means, dithering) for visually lossless logos.</p>
              <div className="tag-row"><span className="badge ok">exact or quantised</span><span className="badge">logos</span><span className="badge">icons</span></div>
            </div>
            <div className="card codec-card hover">
              <div className="card-icon"><Icon name="sparkles" /></div>
              <h3>SMG-W · Wavelet</h3>
              <p>CDF 9/7 wavelet, dead-zone quantisation with perceptual weights and context-modelled coefficients. No 8×8 blocking artefacts; alpha stays lossless.</p>
              <div className="tag-row"><span className="badge warn">lossy</span><span className="badge">photos</span><span className="badge">gradients</span></div>
            </div>
          </div>
          <div className="card" style={{ marginTop: 20 }}>
            <div className="row between wrap" style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>File anatomy</h3>
              <Link to="/format" className="btn sm">Read the specification <Icon name="chevronRight" size={14} /></Link>
            </div>
            <div className="diagram">
              <div><b>89 53 4D 47…</b><span>signature · 8 B</span></div>
              <div><b>1.0</b><span>version · 2 B</span></div>
              <div className="crit"><b>HEAD</b><span>size · model · codec</span></div>
              <div><b>prof · exif · meta</b><span>optional metadata</span></div>
              <div className="crit data"><b>DATA</b><span>entropy-coded payload (SMG-L / P / W)</span></div>
              <div><b>csum</b><span>pixel CRC-32</span></div>
              <div className="crit"><b>TAIL</b><span>end marker</span></div>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: '14px 0 0' }}>Every chunk carries a CRC-32. Unknown ancillary chunks are skipped; unknown critical chunks are rejected — so SMG can grow without breaking old readers.</p>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 24 }}>
        <div className="container grid grid-2" style={{ alignItems: 'start', gap: 40 }}>
          <div>
            <div className="eyebrow">Compatibility</div>
            <h2>Works with the formats you already use</h2>
            <p>Import almost anything your browser can open, export SMG for storage and transfer, and convert back to conventional formats whenever you need to share.</p>
            <div className="notice info" style={{ marginTop: 18 }}>
              AVIF and WebP <em>export</em> depend on your browser’s built-in encoders; the converter tells you when one is unavailable.
            </div>
          </div>
          <div className="table-wrap">
            <table className="data formats-table">
              <thead>
                <tr><th>Format</th><th>Import</th><th>Export</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {[
                  ['SMG', true, true, 'native · lossless & lossy'],
                  ['PNG', true, true, 'exact pixels, 1–16 bit, interlaced'],
                  ['JPEG', true, true, 'EXIF/ICC preserved in SMG'],
                  ['WebP', true, true, 'browser codec'],
                  ['AVIF', true, 'browser', 'where supported'],
                  ['GIF', true, false, 'all frames extracted'],
                  ['BMP', true, true, '1–32 bit, RLE'],
                  ['SVG', true, false, 'rasterised at any size'],
                ].map(([n, i, e, note]) => (
                  <tr key={String(n)}>
                    <td>{n}</td>
                    <td className={i ? 'yes' : 'no'}>{i ? '✓' : '—'}</td>
                    <td className={e ? 'yes' : 'no'}>{e === true ? '✓' : e ? e : '—'}</td>
                    <td className="muted">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 24 }}>
        <div className="container grid grid-3">
          {[
            { icon: 'shield' as IconName, t: 'Private by design', d: 'Decoding, editing and encoding happen in your browser. There is no upload endpoint and no account.' },
            { icon: 'bolt' as IconName, t: 'Never blocks the UI', d: 'Heavy work runs in a pool of Web Workers with progress reporting and instant cancellation.' },
            { icon: 'check' as IconName, t: 'Honest numbers', d: 'Lossless means bit-exact (verified by a stored checksum). Sizes and savings are always measured, never estimated after the fact.' },
          ].map((x) => (
            <div key={x.t} className="card hover">
              <div className="card-icon"><Icon name={x.icon} /></div>
              <h3>{x.t}</h3>
              <p style={{ margin: 0 }}>{x.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" style={{ paddingTop: 24 }}>
        <div className="container">
          <div className="cta">
            <h2>Make your next image smaller.</h2>
            <p className="lead" style={{ margin: '0 auto 28px' }}>Drop a file into the compressor, or start a new design in SMG Studio. Free, private, and open source.</p>
            <div className="row wrap" style={{ justifyContent: 'center', gap: 12 }}>
              <Link to="/compress" className="btn primary lg"><Icon name="compress" /> Compress an image</Link>
              <Link to="/studio" className="btn lg"><Icon name="brush" /> Open Studio</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function lyDeltaSafe(codec: string) {
  return lossyDelta(codec);
}

function ConvertPreview() {
  const rows = [
    ['dashboard.png', 'PNG', 'dashboard.smg'],
    ['logo-badge.png', 'PNG', 'logo-badge.smg'],
    ['landscape.png', 'PNG', 'landscape.smg'],
  ];
  const samples = [
    { file: 'dashboard', smg: bench.images.find((i) => i.file === 'screenshot-dashboard.png') },
    { file: 'badge', smg: bench.images.find((i) => i.file === 'logo-badge.png') },
    { file: 'landscape', smg: bench.images.find((i) => i.file === 'illustration-landscape.png') },
  ];
  return (
    <div className="stack">
      {rows.map(([name, fmt, out], i) => {
        const s = samples[i].smg;
        const outBytes = s ? (i === 0 ? s.lossless.smg.bytes : s.lossy.results.smg.bytes) : 0;
        return (
          <div key={name} className="card pad-s row" style={{ gap: 14 }}>
            <img className="thumb" src={`/samples/${samples[i].file}.png`} alt="" loading="lazy" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{name}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {fmt} · {s ? formatBytes(s.sourceBytes) : '—'} → <span className="mono">{out}</span>
              </div>
            </div>
            <span className="badge ok mono">{formatBytes(outBytes)}</span>
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Sizes from the benchmark corpus (screenshot lossless; logo and landscape in auto mode).</p>
    </div>
  );
}

function CompressPreview() {
  const items = bench.images.filter((i) => i.category === 'photo');
  return (
    <div className="stack">
      {items.map((im) => {
        const smg = im.lossy.results.smg.bytes;
        const pct = (1 - smg / im.sourceBytes) * 100;
        return (
          <div key={im.file} className="card pad-s">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>{im.file}</span>
              <span className="mono muted" style={{ fontSize: 13 }}>
                {formatBytes(im.sourceBytes)} → <span className="gradient-text" style={{ fontWeight: 700 }}>{formatBytes(smg)}</span>
              </span>
            </div>
            <div className="savings-bar">
              <i style={{ width: `${100 - pct}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {pct.toFixed(0)}% smaller than the source PNG · SSIM {im.lossy.results.smg.ssim?.toFixed(3)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

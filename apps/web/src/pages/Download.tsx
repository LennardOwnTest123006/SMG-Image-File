import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '@smg/codec';
import { Icon, type IconName } from '../components/Icon.tsx';
import { REPO_URL } from '../components/Layout.tsx';
import './tool.css';

interface Manifest {
  version: string;
  generatedAt: string;
  files: Array<{ name: string; path: string; kind: string; description: string; bytes: number; sha256: string }>;
}

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const SAMPLES = [
  { file: 'cat.smg', label: 'Photo · wavelet lossy', src: 'cat.png' },
  { file: 'dashboard.smg', label: 'Screenshot · lossless', src: 'dashboard.png' },
  { file: 'badge.smg', label: 'Logo · palette + alpha', src: 'badge.png' },
  { file: 'landscape.smg', label: 'Illustration · auto', src: 'landscape.png' },
];

export default function Download() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [sizes, setSizes] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch('/downloads/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setManifest)
      .catch(() => setFailed(true));
    for (const s of SAMPLES) fetch(`/samples/${s.file}`, { method: 'HEAD' }).then((r) => setSizes((x) => ({ ...x, [s.file]: Number(r.headers.get('content-length') ?? 0) })));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setInstalled(true));
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const icons: Record<string, IconName> = { cli: 'terminal', library: 'code', spec: 'book' };
  return (
    <div className="container" style={{ paddingBottom: 60 }}>
      <div className="page-head">
        <div className="eyebrow">Download</div>
        <h1>Get SMG</h1>
        <p className="lead">Install SMG Studio as an app, grab the command-line tool, or embed the codec in your own project. Everything is free and MIT-licensed.</p>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'stretch' }}>
        <div className="card">
          <div className="card-icon"><Icon name="brush" /></div>
          <h3>SMG Studio desktop app</h3>
          <p>SMG Studio is an installable web app: once installed it opens in its own window, works offline, and registers itself for <code>.smg</code> files where the browser supports file handlers.</p>
          {installed ? (
            <span className="badge ok"><Icon name="check" size={13} /> Installed on this device</span>
          ) : prompt ? (
            <button className="btn primary" onClick={async () => { await prompt.prompt(); const c = await prompt.userChoice; if (c.outcome === 'accepted') setInstalled(true); setPrompt(null); }}>
              <Icon name="download" size={16} /> Install SMG Studio
            </button>
          ) : (
            <div className="notice info" style={{ fontSize: 13 }}>
              To install: in Chrome or Edge use the install icon in the address bar (or menu → “Install SMG”). In Safari on macOS choose File → Add to Dock; on iPhone/iPad use Share → Add to Home Screen.
            </div>
          )}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>Native installers (Electron/Tauri builds) are not provided in v1.0 — the installable web app gives the same features without an extra runtime.</p>
        </div>
        <div className="card">
          <div className="card-icon"><Icon name="terminal" /></div>
          <h3>Command line</h3>
          <p>A single file — no install step beyond Node.js 20 or newer:</p>
          <pre className="mono" style={{ background: '#090b16', padding: 14, borderRadius: 12, fontSize: 13, overflowX: 'auto', margin: '0 0 12px' }}>
{`node smg-${manifest?.version ?? '1.0.0'}.mjs encode photo.jpg -q 80
node smg-${manifest?.version ?? '1.0.0'}.mjs decode photo.smg -o photo.png
node smg-${manifest?.version ?? '1.0.0'}.mjs info photo.smg`}
          </pre>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Optional: <code>npm install sharp</code> next to it adds WebP/AVIF/TIFF/SVG input, WebP/AVIF output and <code>smg benchmark</code>. See the <Link to="/docs#command-line-tool" style={{ color: '#a5b4fc' }}>CLI reference</Link>.</p>
        </div>
      </div>

      <section className="section-tight">
        <h2>Release files</h2>
        {failed && <div className="notice">The download manifest could not be loaded. Build the site with <code>npm run build</code> to generate release files.</div>}
        {manifest && (
          <>
            <div className="stack">
              {manifest.files.map((f) => (
                <div key={f.name} className="file-row" style={{ gridTemplateColumns: '44px minmax(0,1fr) auto' }}>
                  <div className="card-icon" style={{ margin: 0, width: 40, height: 40 }}><Icon name={icons[f.kind] ?? 'file'} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="name mono">{f.name}</div>
                    <div className="meta">
                      <span>{f.description}</span>
                    </div>
                    <div className="mono dim" style={{ fontSize: 11, wordBreak: 'break-all', marginTop: 4 }}>SHA-256 {f.sha256}</div>
                  </div>
                  <div className="actions">
                    <a className="btn sm primary" href={f.path} download={f.name}>
                      <Icon name="download" size={14} /> {formatBytes(f.bytes)}
                    </a>
                  </div>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
              Version {manifest.version} · built {new Date(manifest.generatedAt).toLocaleString()} · <a href="/downloads/SHA256SUMS" style={{ color: '#a5b4fc' }}>SHA256SUMS</a> · verify with <code>sha256sum -c SHA256SUMS</code>
            </p>
          </>
        )}
      </section>

      <section className="section-tight">
        <h2>Sample .smg files</h2>
        <p>Real files produced by the reference encoder — open them in the <Link to="/convert" style={{ color: '#a5b4fc' }}>converter</Link> or inspect them on the <Link to="/format" style={{ color: '#a5b4fc' }}>format page</Link>.</p>
        <div className="grid grid-4">
          {SAMPLES.map((s) => (
            <a key={s.file} className="card pad-s hover" href={`/samples/${s.file}`} download>
              <img src={`/samples/${s.src}`} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 10, marginBottom: 10 }} className="checker" />
              <div style={{ fontWeight: 600 }} className="mono">{s.file}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{s.label}{sizes[s.file] ? ` · ${formatBytes(sizes[s.file])}` : ''}</div>
            </a>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <div className="card row wrap" style={{ gap: 16, justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Source code</h3>
            <p style={{ margin: 0 }}>Codec, CLI, website, tests and benchmark corpus in one repository.</p>
          </div>
          <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer"><Icon name="github" size={16} /> View on GitHub</a>
        </div>
      </section>
    </div>
  );
}

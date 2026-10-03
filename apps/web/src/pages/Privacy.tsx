import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon.tsx';

export default function Privacy() {
  return (
    <div className="container" style={{ paddingBottom: 60, maxWidth: 860 }}>
      <div className="page-head">
        <div className="eyebrow">Privacy</div>
        <h1>Privacy policy</h1>
        <p className="lead">Short version: your images stay on your device. SMG has no accounts, no analytics, no advertising and no upload servers.</p>
      </div>
      <div className="grid grid-3" style={{ marginBottom: 32 }}>
        {[
          { i: 'lock' as const, t: 'Local processing', d: 'Decoding, editing, compression and conversion run in your browser (JavaScript and Web Workers).' },
          { i: 'shield' as const, t: 'No tracking', d: 'No cookies, no analytics scripts, no third-party fonts or CDNs. Fonts are served from this site.' },
          { i: 'folder' as const, t: 'Your storage', d: 'Studio projects and preferences are kept in your browser’s IndexedDB until you delete them.' },
        ].map((x) => (
          <div key={x.t} className="card pad-s">
            <div className="card-icon"><Icon name={x.i} /></div>
            <h3 style={{ fontSize: '1.05rem' }}>{x.t}</h3>
            <p style={{ margin: 0, fontSize: 14 }}>{x.d}</p>
          </div>
        ))}
      </div>
      <article className="prose">
        <h2>What data is processed</h2>
        <p>When you open or drop an image into SMG Studio, the converter or the compressor, the file is read by JavaScript running in your browser tab. Pixels are decoded and encoded in the page and in Web Workers on your device. <strong>Image data is never transmitted to us or to anyone else.</strong> There is no server endpoint that accepts images.</p>
        <h2>What is stored on your device</h2>
        <ul>
          <li><strong>Studio autosave and recent projects</strong> — the document you are editing (layers, text, shapes; pixel layers as lossless SMG) is saved to IndexedDB so you can recover it after a crash or reload. Delete individual projects from <em>File → Recent projects</em>, or clear this site’s data in your browser settings.</li>
          <li><strong>Preferences</strong> — tool and compression settings, also in IndexedDB (or localStorage as a fallback).</li>
          <li><strong>Offline cache</strong> — a service worker caches the application files (HTML, JavaScript, CSS, fonts, sample images) so the app works offline. It never caches your images.</li>
        </ul>
        <h2>What our hosting provider sees</h2>
        <p>The website is static and hosted on Netlify. Like any web server, the host processes standard request information (IP address, user agent, requested URL, time) to deliver the site and protect it from abuse. We do not add analytics or tracking on top of that, and we do not receive your images. See Netlify’s privacy policy for their handling of server logs.</p>
        <h2>Downloads</h2>
        <p>Files you export (SMG, PNG, JPEG, WebP, ZIP, project files) are created in your browser and handed to your browser’s download mechanism.</p>
        <h2>Features that would need a server</h2>
        <p>None of the current features require a server. If a future feature ever does (for example, sharing a link to an image), it will be opt-in, clearly labelled, and documented here before release.</p>
        <h2>Children</h2>
        <p>SMG does not knowingly collect any personal data, from children or adults.</p>
        <h2>Changes</h2>
        <p>Changes to this policy are published on this page and in the project’s source repository. Last updated: October 2026.</p>
        <h2>Contact</h2>
        <p>Questions? Open an issue in the project repository (linked from the <Link to="/download">download page</Link>).</p>
      </article>
    </div>
  );
}

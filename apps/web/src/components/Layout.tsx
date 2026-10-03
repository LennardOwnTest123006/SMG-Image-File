import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from './Icon.tsx';
import { LogoMark } from './ui.tsx';

const NAV = [
  { to: '/studio', label: 'Studio' },
  { to: '/convert', label: 'Convert' },
  { to: '/compress', label: 'Compress' },
  { to: '/format', label: 'Format' },
  { to: '/benchmarks', label: 'Benchmarks' },
  { to: '/docs', label: 'Docs' },
  { to: '/download', label: 'Download' },
];

export const REPO_URL = 'https://github.com/LennardOwnTest123006/SMG-Image-File';

export function Header() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <header className="site-header">
      <div className="container wide">
        <Link to="/" className="brand" aria-label="SMG home">
          <LogoMark size={30} />
          <span>SMG</span>
        </Link>
        <nav className={`nav${open ? ' open' : ''}`} aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <Link to="/studio" className="btn primary sm header-cta">
          <Icon name="brush" size={15} /> Open Studio
        </Link>
        <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'x' : 'menu'} />
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <Link to="/" className="brand" style={{ marginBottom: 14 }}>
              <LogoMark size={28} /> SMG
            </Link>
            <p style={{ fontSize: 14, maxWidth: 34 + 'ch' }}>An open image format and a private, in-browser image studio. Images. Smaller. Smarter.</p>
            <span className="badge brand">
              <Icon name="lock" size={13} /> Your images never leave your device
            </span>
          </div>
          <div>
            <h4>Tools</h4>
            <Link to="/studio">SMG Studio</Link>
            <Link to="/convert">Converter</Link>
            <Link to="/compress">Compressor</Link>
            <Link to="/download">CLI &amp; downloads</Link>
          </div>
          <div>
            <h4>Format</h4>
            <Link to="/format">Specification</Link>
            <Link to="/benchmarks">Benchmarks</Link>
            <Link to="/docs">Developer docs</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">Source code</a>
          </div>
          <div>
            <h4>Project</h4>
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy</Link>
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License</a>
          </div>
        </div>
        <div className="row between wrap" style={{ marginTop: 40, fontSize: 13, color: 'var(--dim)' }}>
          <span>© 2026 SMG contributors · v{__APP_VERSION__}</span>
          <span>No accounts · no tracking · no uploads</span>
        </div>
      </div>
    </footer>
  );
}

export function Layout() {
  const loc = useLocation();
  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  const bare = loc.pathname.startsWith('/studio');
  return (
    <>
      <Header />
      <main id="main">
        <Outlet />
      </main>
      {!bare && <Footer />}
    </>
  );
}

import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Link } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/global.css';
import { Layout } from './components/Layout.tsx';
import { ToastProvider } from './components/ui.tsx';
import Home from './pages/Home.tsx';

const Studio = lazy(() => import('./studio/Studio.tsx'));
const Convert = lazy(() => import('./pages/Convert.tsx'));
const Compress = lazy(() => import('./pages/Compress.tsx'));
const Format = lazy(() => import('./pages/Format.tsx'));
const Benchmarks = lazy(() => import('./pages/Benchmarks.tsx'));
const Docs = lazy(() => import('./pages/Docs.tsx'));
const Download = lazy(() => import('./pages/Download.tsx'));
const Privacy = lazy(() => import('./pages/Privacy.tsx'));
const About = lazy(() => import('./pages/About.tsx'));

function Loading() {
  return (
    <div className="container" style={{ padding: '120px 20px', display: 'grid', placeItems: 'center' }}>
      <div className="spinner" style={{ width: 28, height: 28 }} />
    </div>
  );
}

function NotFound() {
  return (
    <section className="container" style={{ padding: '120px 20px', textAlign: 'center' }}>
      <h1 className="gradient-text">404</h1>
      <p>This page doesn’t exist — but your images can still get smaller.</p>
      <Link className="btn primary" to="/">
        Back to home
      </Link>
    </section>
  );
}

const wrap = (el: React.ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/studio', element: wrap(<Studio />) },
      { path: '/convert', element: wrap(<Convert />) },
      { path: '/compress', element: wrap(<Compress />) },
      { path: '/format', element: wrap(<Format />) },
      { path: '/benchmarks', element: wrap(<Benchmarks />) },
      { path: '/docs', element: wrap(<Docs />) },
      { path: '/download', element: wrap(<Download />) },
      { path: '/privacy', element: wrap(<Privacy />) },
      { path: '/about', element: wrap(<About />) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);

// Offline support (installable PWA) in production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline mode unavailable — the site still works online */
    });
  });
}

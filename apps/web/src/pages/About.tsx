import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon.tsx';
import { LogoMark } from '../components/ui.tsx';
import { bench, lossyDelta } from '../data/bench.ts';

export default function About() {
  return (
    <div className="container" style={{ paddingBottom: 60, maxWidth: 960 }}>
      <div className="page-head">
        <div className="eyebrow">About</div>
        <div className="row" style={{ gap: 16, marginBottom: 12 }}>
          <LogoMark size={56} />
          <h1 style={{ margin: 0 }}>About SMG</h1>
        </div>
        <p className="lead">SMG is an open image format and toolset built around one idea: images should be as small as their content allows — and every claim about size or quality should be measured.</p>
      </div>
      <div className="grid grid-2" style={{ marginBottom: 32 }}>
        <div className="card">
          <h3>What SMG is</h3>
          <ul className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0, color: 'var(--text-2)' }}>
            <li>A documented binary container (<code>.smg</code>) with versioning, CRC-protected chunks and forward-compatible extensions.</li>
            <li>Three original codecs on a shared adaptive range coder: predictive lossless with LZ copies, palette, and wavelet lossy.</li>
            <li>A zero-dependency TypeScript reference implementation, a CLI, and a browser-based studio, converter and compressor.</li>
          </ul>
        </div>
        <div className="card">
          <h3>What SMG is not</h3>
          <ul className="stack" style={{ gap: 8, paddingLeft: 18, margin: 0, color: 'var(--text-2)' }}>
            <li>Not natively supported by web browsers or operating systems — share PNG/JPEG/WebP exports with people who don’t use SMG tools.</li>
            <li>Not the smallest format in every case: at equal SSIM on our corpus, SMG files are {lossyDelta('avif').delta >= 0 ? `${lossyDelta('avif').delta.toFixed(1)}% larger` : `${(-lossyDelta('avif').delta).toFixed(1)}% smaller`} than AVIF, and WebP lossless wins on some screenshots.</li>
            <li>Not as fast as native C codecs; SMG runs in JavaScript.</li>
            <li>Not (yet) for animation, HDR or more than 8 bits per channel.</li>
          </ul>
        </div>
      </div>
      <article className="prose" style={{ maxWidth: 'none' }}>
        <h2>Design principles</h2>
        <ol>
          <li><strong>Honesty.</strong> Lossless means bit-exact, verified by a stored checksum. Reported sizes are the actual output. Benchmarks are reproducible and include the cases where SMG loses.</li>
          <li><strong>Privacy.</strong> Everything runs on your device. No accounts, uploads or tracking.</li>
          <li><strong>Openness.</strong> The specification, reference code and tests are public under the MIT license.</li>
          <li><strong>Robustness.</strong> Every input is validated; corrupt files fail with clear error codes instead of crashing.</li>
        </ol>
        <h2>Credits &amp; prior art</h2>
        <p>SMG’s codecs combine established techniques from the image-compression literature: range coding, the LOCO-I/JPEG-LS median predictor and bias cancellation, CALIC-style gradient-adjusted prediction, FLIF/JPEG XL-style integer binarisation, YCoCg-R, WebP-style subtract-green, backward references and colour cache, and the CDF 9/7 wavelet used in JPEG 2000. The container’s critical/ancillary chunk convention follows PNG. These ideas belong to their inventors; the SMG-specific container, bitstreams, context models and implementation are this project’s. See the <Link to="/format">specification</Link> (§13) for details.</p>
        <p>Benchmark photographs: astronaut (NASA, public domain), coffee (Rachel Michetti, CC0) and Chelsea the cat (Stefan van der Walt, CC0), via the scikit-image project. Fonts: Inter, Space Grotesk and JetBrains Mono (SIL Open Font License 1.1), self-hosted. Libraries: React, React Router, marked, fflate, jpeg-js (CLI), and sharp/libvips for reference benchmarks only.</p>
        <h2>Version</h2>
        <p>Format 1.0 · software {__APP_VERSION__} · benchmark data from {new Date(bench.generatedAt).toLocaleDateString()}.</p>
      </article>
      <div className="row wrap" style={{ gap: 10, marginTop: 24 }}>
        <Link to="/studio" className="btn primary"><Icon name="brush" size={16} /> Open Studio</Link>
        <Link to="/benchmarks" className="btn"><Icon name="chart" size={16} /> Benchmarks</Link>
        <Link to="/privacy" className="btn"><Icon name="shield" size={16} /> Privacy</Link>
      </div>
    </div>
  );
}

import { Link } from 'react-router-dom';
import guide from '../../../../docs/DEVELOPER.md?raw';
import { Icon } from '../components/Icon.tsx';
import { REPO_URL } from '../components/Layout.tsx';
import { Prose, Toc, useMarkdown } from '../components/Markdown.tsx';
import './format.css';

export default function Docs() {
  const { html, toc } = useMarkdown(guide);
  return (
    <div className="container" style={{ paddingBottom: 60 }}>
      <div className="page-head">
        <div className="eyebrow">Developers</div>
        <h1>Use SMG in your own code</h1>
        <p className="lead">A zero-dependency TypeScript codec, a command-line tool, and a documented binary format.</p>
        <div className="row wrap" style={{ gap: 10, marginTop: 18 }}>
          <Link to="/download" className="btn primary"><Icon name="download" size={16} /> Download CLI &amp; library</Link>
          <Link to="/format" className="btn"><Icon name="book" size={16} /> Format specification</Link>
          <a href={REPO_URL} className="btn" target="_blank" rel="noreferrer"><Icon name="github" size={16} /> Source code</a>
        </div>
      </div>
      <div className="doc-layout">
        <Toc toc={toc} />
        <Prose html={html} />
      </div>
    </div>
  );
}

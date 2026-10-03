/** Renders first-party Markdown (docs/*.md, bundled at build time) with heading anchors and a TOC. */
import { useEffect, useMemo } from 'react';
import { Marked } from 'marked';
import { useLocation } from 'react-router-dom';

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

export function useMarkdown(src: string): { html: string; toc: TocEntry[] } {
  return useMemo(() => {
    const toc: TocEntry[] = [];
    const used = new Map<string, number>();
    const md = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth }) {
          const text = this.parser.parseInline(tokens);
          let id = slug(text);
          const n = used.get(id) ?? 0;
          used.set(id, n + 1);
          if (n) id = `${id}-${n}`;
          if (depth === 2 || depth === 3) toc.push({ id, text: text.replace(/<[^>]+>/g, ''), level: depth });
          if (depth === 1) return `<h1 id="${id}">${text}</h1>`;
          return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>`;
        },
      },
    });
    const html = md.parse(src) as string;
    return { html, toc };
  }, [src]);
}

export function Toc({ toc, title = 'On this page' }: { toc: TocEntry[]; title?: string }) {
  return (
    <nav className="toc" aria-label={title}>
      <div className="label" style={{ marginBottom: 10 }}>{title}</div>
      {toc.map((t) => (
        <a key={t.id} href={`#${t.id}`} className={t.level === 3 ? 'l3' : ''}>
          {t.text}
        </a>
      ))}
    </nav>
  );
}

export function Prose({ html }: { html: string }) {
  const loc = useLocation();
  useEffect(() => {
    if (loc.hash) document.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView();
  }, [loc.hash, html]);
  return <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

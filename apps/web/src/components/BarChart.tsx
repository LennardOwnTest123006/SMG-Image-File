/**
 * Horizontal bar chart (HTML). One highlighted series (SMG, accent) against
 * neutral bars; values labelled at the bar tip; hover tooltip per bar.
 * Colours validated with the dataviz palette checker against the chart surface.
 */
import { useState } from 'react';

export interface Bar {
  label: string;
  value: number | null;
  highlight?: boolean;
  note?: string;
}

export function BarChart({ bars, format, title, caption }: { bars: Bar[]; format: (v: number) => string; title?: string; caption?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value ?? 0));
  return (
    <figure className="barchart" aria-label={title}>
      {title && <figcaption className="bc-title">{title}</figcaption>}
      <div className="bc-rows" role="table">
        {bars.map((b, i) => (
          <div key={b.label} className="bc-row" role="row" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="bc-label" role="rowheader">{b.label}</span>
            <span className="bc-track" role="cell">
              {b.value !== null ? (
                <>
                  <i className={`bc-bar${b.highlight ? ' hl' : ''}`} style={{ width: `${Math.max(0.5, (b.value / max) * 100)}%` }} />
                  <span className="bc-val">{format(b.value)}</span>
                </>
              ) : (
                <span className="bc-val dim">{b.note ?? 'n/a'}</span>
              )}
              {hover === i && b.value !== null && (
                <span className="bc-tip" role="tooltip">
                  <b>{b.label}</b> · {format(b.value)}
                  {b.note ? ` · ${b.note}` : ''}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      {caption && <p className="bc-caption">{caption}</p>}
    </figure>
  );
}

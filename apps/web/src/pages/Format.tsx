import { useEffect, useState } from 'react';
import { formatBytes, type SmgInfo } from '@smg/codec';
import spec from '../../../../docs/SPEC.md?raw';
import { Prose, Toc, useMarkdown } from '../components/Markdown.tsx';
import { Dropzone, useToast } from '../components/ui.tsx';
import { codec } from '../lib/codec-client.ts';
import { cleanError } from '../lib/images.ts';
import './format.css';

const REGION_COLORS: Record<string, string> = { sig: '#3d7bff', ver: '#22d3ee', HEAD: '#a855f7', DATA: '#6a5cff', TAIL: '#ec4899', anc: '#f59e0b' };

interface Region {
  start: number;
  end: number;
  kind: string;
  label: string;
}

function regionsFor(info: SmgInfo, bytes: Uint8Array): Region[] {
  const r: Region[] = [
    { start: 0, end: 8, kind: 'sig', label: 'Signature' },
    { start: 8, end: 10, kind: 'ver', label: 'Version' },
  ];
  for (const c of info.chunks) {
    // tag(4) + varint length + payload + crc(4)
    let p = c.offset + 4;
    while (bytes[p] & 0x80) p++;
    p++;
    const payloadStart = p;
    const end = payloadStart + c.length + 4;
    r.push({ start: c.offset, end: payloadStart, kind: c.critical ? c.tag : 'anc', label: `${c.tag} header` });
    if (c.length) r.push({ start: payloadStart, end: payloadStart + c.length, kind: c.critical ? c.tag : 'anc', label: `${c.tag} payload (${c.length} B)` });
    r.push({ start: payloadStart + c.length, end, kind: c.critical ? c.tag : 'anc', label: `${c.tag} CRC-32` });
  }
  return r;
}

function ByteExplorer() {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; info: SmgInfo } | null>(null);
  const [hover, setHover] = useState<Region | null>(null);

  const load = async (name: string, bytes: Uint8Array) => {
    try {
      const info = await codec.inspect(bytes);
      setFile({ name, bytes, info });
    } catch (e) {
      toast(`${name}: ${cleanError(e)}`, 'error');
    }
  };

  useEffect(() => {
    fetch('/samples/badge.smg')
      .then((r) => r.arrayBuffer())
      .then((b) => load('badge.smg', new Uint8Array(b)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const regions = file ? regionsFor(file.info, file.bytes) : [];
  const SHOW = 192;
  const dataRegion = regions.find((r) => r.label.startsWith('DATA payload'));
  // Show the first bytes and the tail of the file (DATA payload elided in the middle).
  const ranges: Array<[number, number]> = file ? (file.bytes.length <= SHOW * 2 ? [[0, file.bytes.length]] : [[0, Math.min(SHOW, dataRegion ? dataRegion.start + 48 : SHOW)], [file.bytes.length - 64, file.bytes.length]]) : [];
  const regionAt = (i: number) => regions.find((r) => i >= r.start && i < r.end);
  return (
    <div className="card" style={{ marginBottom: 32 }}>
      <div className="row between wrap" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Byte explorer</h3>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13.5 }}>Hover the bytes to see how an SMG file is laid out. Drop your own .smg to inspect it.</p>
        </div>
        <div style={{ width: 260 }}>
          <Dropzone compact multiple={false} accept=".smg" onFiles={async (f) => load(f[0].name, new Uint8Array(await f[0].arrayBuffer()))}>
            <span className="muted" style={{ fontSize: 13 }}>Drop an .smg file</span>
          </Dropzone>
        </div>
      </div>
      {file && (
        <>
          <div className="legend-row">
            {Object.entries({ sig: 'Signature', ver: 'Version', HEAD: 'HEAD', anc: 'Ancillary (meta, csum…)', DATA: 'DATA', TAIL: 'TAIL' }).map(([k, l]) => (
              <span key={k}><i style={{ background: REGION_COLORS[k] }} />{l}</span>
            ))}
          </div>
          <div className="hex" onMouseLeave={() => setHover(null)}>
            {ranges.map(([a, b], ri) => (
              <div key={ri}>
                {ri > 0 && <div className="hex-gap">… {formatBytes(ranges[ri][0] - ranges[ri - 1][1])} of entropy-coded DATA omitted …</div>}
                <div className="hex-grid">
                  {Array.from({ length: b - a }, (_, k) => {
                    const i = a + k;
                    const reg = regionAt(i);
                    const isHover = hover && reg === hover;
                    return (
                      <span key={i} className={`hb${isHover ? ' on' : ''}`} style={{ color: reg ? REGION_COLORS[reg.kind] ?? REGION_COLORS.anc : undefined }} onMouseEnter={() => setHover(reg ?? null)} title={`offset ${i}${reg ? ` · ${reg.label}` : ''}`}>
                        {file.bytes[i].toString(16).padStart(2, '0')}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="row between wrap" style={{ marginTop: 12, fontSize: 13 }}>
            <span className="mono">{hover ? `${hover.label} · bytes ${hover.start}–${hover.end - 1}` : `${file.name} · ${formatBytes(file.info.fileBytes)} · ${file.info.width}×${file.info.height} · ${file.info.codecName}`}</span>
            <span className="muted">{file.info.chunks.map((c) => c.tag).join(' → ')}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function Format() {
  const { html, toc } = useMarkdown(spec);
  return (
    <div className="container" style={{ paddingBottom: 60 }}>
      <div className="page-head">
        <div className="eyebrow">Specification</div>
        <h1>The SMG format, byte by byte</h1>
        <p className="lead">A versioned container of CRC-protected chunks with three entropy-coded codecs. Everything needed to write an independent decoder is below; the reference implementation is MIT-licensed.</p>
      </div>
      <ByteExplorer />
      <div className="doc-layout">
        <Toc toc={toc} />
        <Prose html={html} />
      </div>
    </div>
  );
}

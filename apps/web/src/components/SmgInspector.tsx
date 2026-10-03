import type { SmgInfo } from '@smg/codec';
import { formatBytes } from '@smg/codec';

/** Human-readable view of an SMG file's header, chunks and metadata. */
export function SmgInspector({ info }: { info: SmgInfo }) {
  const md = info.metadata;
  const fidelity = info.exact ? 'Lossless (bit-exact)' : info.visuallyLossless ? 'Visually lossless' : info.quantized ? 'Lossy (palette quantised)' : 'Lossy';
  return (
    <div className="stack" style={{ gap: 18 }}>
      <dl className="kv">
        <dt>Format</dt><dd>SMG {info.versionMajor}.{info.versionMinor}</dd>
        <dt>Dimensions</dt><dd>{info.width} × {info.height} ({((info.width * info.height) / 1e6).toFixed(2)} MP)</dd>
        <dt>Colour model</dt><dd>{info.colorModelName}, {info.bitDepth}-bit</dd>
        <dt>Codec</dt><dd>{info.codecName}</dd>
        <dt>Fidelity</dt><dd>{fidelity}{info.quality !== null ? ` · quality ${info.quality}` : ''}</dd>
        <dt>File size</dt><dd>{formatBytes(info.fileBytes)} ({info.fileBytes} B · {((info.fileBytes * 8) / (info.width * info.height)).toFixed(3)} bpp)</dd>
        <dt>Payload</dt><dd>{formatBytes(info.payloadBytes)}</dd>
        <dt>Pixel checksum</dt><dd>{info.checksum !== null ? `CRC-32 ${info.checksum.toString(16).padStart(8, '0')} (verified on decode)` : 'none'}</dd>
      </dl>
      <div>
        <div className="label" style={{ marginBottom: 8 }}>Chunks</div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Tag</th><th>Kind</th><th className="num">Offset</th><th className="num">Length</th></tr>
            </thead>
            <tbody>
              {info.chunks.map((c) => (
                <tr key={`${c.tag}-${c.offset}`}>
                  <td className="mono">{c.tag}</td>
                  <td>{c.critical ? 'critical' : 'ancillary'}</td>
                  <td className="num">{c.offset}</td>
                  <td className="num">{c.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div className="label" style={{ marginBottom: 8 }}>Metadata</div>
        {!md.text && !md.icc && !md.exif && !md.xmp ? (
          <div className="muted" style={{ fontSize: 13.5 }}>No metadata stored.</div>
        ) : (
          <dl className="kv">
            {md.text && Object.entries(md.text).map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd style={{ fontFamily: 'var(--font-ui)' }}>{v}</dd>
              </span>
            ))}
            {md.icc && (<><dt>ICC profile</dt><dd>{formatBytes(md.icc.length)}</dd></>)}
            {md.exif && (<><dt>EXIF</dt><dd>{formatBytes(md.exif.length)}</dd></>)}
            {md.xmp && (<><dt>XMP</dt><dd>{md.xmp.length} characters</dd></>)}
          </dl>
        )}
      </div>
    </div>
  );
}

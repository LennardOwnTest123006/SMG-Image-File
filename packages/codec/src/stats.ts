/** Human-readable byte size using binary-free SI-style units (1 KB = 1000 B). */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  if (abs < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = abs / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(digits);
  return `${bytes < 0 ? '-' : ''}${s} ${units[u]}`;
}

export interface CompressionStats {
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  /** Percentage reduction (can be negative when the output is larger). */
  reductionPercent: number;
  /** original / compressed. */
  ratio: number;
  bitsPerPixel: number | null;
}

export function compressionStats(originalBytes: number, compressedBytes: number, pixels?: number): CompressionStats {
  const saved = originalBytes - compressedBytes;
  return {
    originalBytes,
    compressedBytes,
    savedBytes: saved,
    reductionPercent: originalBytes > 0 ? (saved / originalBytes) * 100 : 0,
    ratio: compressedBytes > 0 ? originalBytes / compressedBytes : Infinity,
    bitsPerPixel: pixels ? (compressedBytes * 8) / pixels : null,
  };
}

/** e.g. "Original: 1.2 MB · SMG: 180 KB · Space saved: 85%". */
export function describeStats(s: CompressionStats, label = 'SMG'): string {
  const pct = s.reductionPercent;
  const saved = pct >= 0 ? `Space saved: ${pct.toFixed(pct < 10 ? 1 : 0)}%` : `Larger by ${(-pct).toFixed(1)}%`;
  return `Original: ${formatBytes(s.originalBytes)} · ${label}: ${formatBytes(s.compressedBytes)} · ${saved}`;
}

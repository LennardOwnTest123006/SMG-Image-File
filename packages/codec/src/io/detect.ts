/** Identify an image file format from its leading bytes. */
export type ImageFormat = 'smg' | 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'avif' | 'heic' | 'tiff' | 'svg' | 'ico' | 'unknown';

export const FORMAT_LABELS: Record<ImageFormat, string> = {
  smg: 'SMG',
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  bmp: 'BMP',
  webp: 'WebP',
  avif: 'AVIF',
  heic: 'HEIC',
  tiff: 'TIFF',
  svg: 'SVG',
  ico: 'ICO',
  unknown: 'Unknown',
};

export const FORMAT_MIME: Record<ImageFormat, string> = {
  smg: 'image/x-smg',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  unknown: 'application/octet-stream',
};

export function detectFormat(b: Uint8Array): ImageFormat {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x53 && b[2] === 0x4d && b[3] === 0x47) return 'smg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'heic';
  }
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  // SVG: text that contains an <svg element near the start.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, Math.min(b.length, 2048))).trimStart().toLowerCase();
  if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!--') || head.startsWith('<!doctype svg')) && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

/**
 * Extract metadata (ICC profile, EXIF, XMP) from a JPEG without decoding
 * pixels, and read the EXIF orientation tag.
 */
export interface JpegMetadata {
  icc?: Uint8Array;
  exif?: Uint8Array;
  xmp?: string;
  width?: number;
  height?: number;
}

export function readJpegMetadata(b: Uint8Array): JpegMetadata {
  const out: JpegMetadata = {};
  if (b[0] !== 0xff || b[1] !== 0xd8) return out;
  const iccParts: Array<[number, Uint8Array]> = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { p += marker === 0xff ? 1 : 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end
    const len = (b[p + 2] << 8) | b[p + 3];
    const seg = b.subarray(p + 4, p + 2 + len);
    if (marker === 0xe1) {
      if (seg.length > 6 && seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66 && seg[4] === 0 && seg[5] === 0) out.exif = seg.slice(6);
      else {
        const ns = 'http://ns.adobe.com/xap/1.0/\0';
        const head = new TextDecoder('latin1').decode(seg.subarray(0, ns.length));
        if (head === ns) out.xmp = new TextDecoder().decode(seg.subarray(ns.length));
      }
    } else if (marker === 0xe2) {
      const tag = 'ICC_PROFILE\0';
      if (new TextDecoder('latin1').decode(seg.subarray(0, 12)) === tag) iccParts.push([seg[12], seg.subarray(14)]);
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      out.height = (seg[1] << 8) | seg[2];
      out.width = (seg[3] << 8) | seg[4];
    }
    p += 2 + len;
  }
  if (iccParts.length) {
    iccParts.sort((a, c) => a[0] - c[0]);
    const total = iccParts.reduce((s, [, d]) => s + d.length, 0);
    const icc = new Uint8Array(total);
    let o = 0;
    for (const [, d] of iccParts) { icc.set(d, o); o += d.length; }
    out.icc = icc;
  }
  return out;
}

/** EXIF orientation (1..8), or 1 when absent/unreadable. `exif` is TIFF-structured. */
export function exifOrientation(exif: Uint8Array | undefined): number {
  if (!exif || exif.length < 14) return 1;
  const le = exif[0] === 0x49;
  const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    return 1;
  }
  return 1;
}

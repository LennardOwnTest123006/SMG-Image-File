/**
 * Ancillary metadata chunks.
 *
 *  meta : varint count, then count × (string key, string value)  — UTF-8 text
 *  prof : u8 kind (1 = ICC profile) + raw profile bytes
 *  exif : raw EXIF (TIFF-structured) bytes, without the "Exif\0\0" prefix
 *  xmpd : UTF-8 XMP packet
 *  csum : u8 algorithm (1 = CRC-32 of decoded RGBA8 pixels) + u32 value
 */
import { ByteReader, ByteWriter } from './bytes.ts';
import { fail, SmgErrorCode } from './errors.ts';

export interface SmgMetadata {
  /** Free-form text key/value pairs (e.g. Title, Author, Copyright, Software, Created). */
  text?: Record<string, string>;
  /** ICC colour profile bytes. */
  icc?: Uint8Array;
  /** EXIF (TIFF) bytes. */
  exif?: Uint8Array;
  /** XMP packet. */
  xmp?: string;
}

export const MAX_TEXT_ENTRIES = 1024;

export function encodeText(text: Record<string, string>): Uint8Array {
  const entries = Object.entries(text).filter(([k]) => k.length > 0);
  if (entries.length > MAX_TEXT_ENTRIES) fail(SmgErrorCode.INVALID_ARGUMENT, 'too many metadata entries');
  const w = new ByteWriter(256).varint(entries.length);
  for (const [k, v] of entries) w.string(k).string(String(v));
  return w.finish();
}

export function decodeText(payload: Uint8Array): Record<string, string> {
  const r = new ByteReader(payload, 0, payload.length, 'meta chunk');
  const n = r.varint();
  if (n > MAX_TEXT_ENTRIES) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'too many metadata entries');
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const k = r.string(4096);
    out[k] = r.string(1 << 20);
  }
  return out;
}

export function encodeProfile(icc: Uint8Array): Uint8Array {
  const out = new Uint8Array(icc.length + 1);
  out[0] = 1;
  out.set(icc, 1);
  return out;
}

export function decodeProfile(payload: Uint8Array): Uint8Array | undefined {
  if (payload.length < 1) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'empty prof chunk');
  return payload[0] === 1 ? payload.slice(1) : undefined;
}

export function encodeChecksum(crc: number): Uint8Array {
  return new ByteWriter(5).u8(1).u32(crc).finish();
}

export function decodeChecksum(payload: Uint8Array): number | undefined {
  const r = new ByteReader(payload, 0, payload.length, 'csum chunk');
  const alg = r.u8();
  return alg === 1 ? r.u32() : undefined;
}

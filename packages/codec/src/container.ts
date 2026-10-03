/**
 * SMG container: signature, version, and CRC-protected chunks.
 *
 *   File   := Signature(8) VersionMajor(u8) VersionMinor(u8) Chunk+
 *   Chunk  := Tag(4 ASCII) Length(varint) Payload(Length) CRC32(u32 LE)
 *
 * The CRC covers the tag, the length bytes and the payload. A chunk whose tag
 * starts with an upper-case letter is *critical*: a decoder that does not
 * understand it must reject the file. Lower-case first letter = *ancillary*:
 * unknown ancillary chunks are skipped. See docs/SPEC.md.
 */
import { ByteReader, ByteWriter } from './bytes.ts';
import { crc32 } from './crc32.ts';
import { fail, SmgErrorCode } from './errors.ts';
import { ColorModel } from './types.ts';

export const SIGNATURE = new Uint8Array([0x89, 0x53, 0x4d, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const VERSION_MAJOR = 1;
export const VERSION_MINOR = 0;
export const MIME_TYPE = 'image/x-smg';
export const FILE_EXTENSION = '.smg';

export const ChunkTag = {
  HEAD: 'HEAD',
  DATA: 'DATA',
  TAIL: 'TAIL',
  PROFILE: 'prof',
  EXIF: 'exif',
  XMP: 'xmpd',
  META: 'meta',
  CHECKSUM: 'csum',
} as const;

const KNOWN_CRITICAL = new Set<string>([ChunkTag.HEAD, ChunkTag.DATA, ChunkTag.TAIL]);

export interface Header {
  width: number;
  height: number;
  colorModel: number;
  bitDepth: number;
  codec: number;
  flags: number;
  /** 0..100 for lossy encodings, 255 when not applicable. */
  quality: number;
}

export interface RawChunk {
  tag: string;
  offset: number;
  length: number;
  payload: Uint8Array;
  critical: boolean;
}

export interface DecodeLimits {
  /** Maximum width or height in pixels (default 32768). */
  maxDimension?: number;
  /** Maximum total pixels (default 100 megapixels). */
  maxPixels?: number;
}

export const DEFAULT_LIMITS: Required<DecodeLimits> = {
  maxDimension: 32768,
  maxPixels: 100_000_000,
};

/** Absolute format limit (spec): dimensions are < 2^24. */
export const MAX_FORMAT_DIMENSION = (1 << 24) - 1;

export function isSmg(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

function writeChunk(w: ByteWriter, tag: string, payload: Uint8Array): void {
  const head = new ByteWriter(16);
  for (let i = 0; i < 4; i++) head.u8(tag.charCodeAt(i));
  head.varint(payload.length);
  const hb = head.finish();
  const tmp = new Uint8Array(hb.length + payload.length);
  tmp.set(hb);
  tmp.set(payload, hb.length);
  w.bytes(tmp);
  w.u32(crc32(tmp));
}

export function encodeHeader(h: Header): Uint8Array {
  return new ByteWriter(16).varint(h.width).varint(h.height).u8(h.colorModel).u8(h.bitDepth).u8(h.codec).u8(h.flags).u8(h.quality).finish();
}

export function parseHeader(payload: Uint8Array): Header {
  const r = new ByteReader(payload, 0, payload.length, 'HEAD chunk');
  const h: Header = {
    width: r.varint(),
    height: r.varint(),
    colorModel: r.u8(),
    bitDepth: r.u8(),
    codec: r.u8(),
    flags: r.u8(),
    quality: r.u8(),
  };
  // Trailing bytes are permitted (added by future minor versions) and ignored.
  if (h.width < 1 || h.height < 1 || h.width > MAX_FORMAT_DIMENSION || h.height > MAX_FORMAT_DIMENSION) {
    fail(SmgErrorCode.BAD_HEADER, `invalid dimensions ${h.width}×${h.height}`);
  }
  if (h.colorModel < ColorModel.GRAY || h.colorModel > ColorModel.RGBA) fail(SmgErrorCode.BAD_HEADER, `invalid colour model ${h.colorModel}`);
  if (h.bitDepth !== 8) fail(SmgErrorCode.BAD_HEADER, `unsupported bit depth ${h.bitDepth}`);
  if (h.quality > 100 && h.quality !== 255) fail(SmgErrorCode.BAD_HEADER, `invalid quality ${h.quality}`);
  return h;
}

export interface ContainerParts {
  header: Header;
  data: Uint8Array;
  ancillary: Array<{ tag: string; payload: Uint8Array }>;
}

export function writeContainer(parts: ContainerParts): Uint8Array {
  const w = new ByteWriter(parts.data.length + 256);
  w.bytes(SIGNATURE).u8(VERSION_MAJOR).u8(VERSION_MINOR);
  writeChunk(w, ChunkTag.HEAD, encodeHeader(parts.header));
  for (const a of parts.ancillary) {
    if (!/^[a-z][A-Za-z0-9_ ]{3}$/.test(a.tag)) fail(SmgErrorCode.INVALID_ARGUMENT, `invalid ancillary chunk tag "${a.tag}"`);
    writeChunk(w, a.tag, a.payload);
  }
  writeChunk(w, ChunkTag.DATA, parts.data);
  writeChunk(w, ChunkTag.TAIL, new Uint8Array(0));
  return w.finish();
}

export interface ParsedContainer {
  versionMajor: number;
  versionMinor: number;
  header: Header;
  chunks: RawChunk[];
  data: Uint8Array;
}

/** Parse and validate the container structure (signature, version, chunk order, CRCs). */
export function readContainer(bytes: Uint8Array, limits: DecodeLimits = {}): ParsedContainer {
  if (!(bytes instanceof Uint8Array)) fail(SmgErrorCode.INVALID_ARGUMENT, 'input must be a Uint8Array');
  if (bytes.length < SIGNATURE.length + 2) {
    if (bytes.length >= 4 && isSmgPrefix(bytes)) fail(SmgErrorCode.TRUNCATED, 'file is too short');
    fail(SmgErrorCode.BAD_SIGNATURE, 'not an SMG file (missing signature)');
  }
  if (!isSmg(bytes)) fail(SmgErrorCode.BAD_SIGNATURE, 'not an SMG file (bad signature)');
  const major = bytes[8];
  const minor = bytes[9];
  if (major !== VERSION_MAJOR) fail(SmgErrorCode.UNSUPPORTED_VERSION, `unsupported SMG version ${major}.${minor} (this decoder supports ${VERSION_MAJOR}.x)`);
  const r = new ByteReader(bytes, 10, bytes.length, 'SMG file');
  const chunks: RawChunk[] = [];
  let header: Header | null = null;
  let data: Uint8Array | null = null;
  let sawTail = false;
  while (r.remaining > 0) {
    if (sawTail) fail(SmgErrorCode.CHUNK_ORDER, 'data after TAIL chunk');
    const start = r.pos;
    const tagBytes = r.bytes(4);
    const tag = String.fromCharCode(...tagBytes);
    if (!/^[A-Za-z][A-Za-z0-9_ ]{3}$/.test(tag)) fail(SmgErrorCode.CORRUPT_PAYLOAD, `invalid chunk tag at offset ${start}`);
    const len = r.varint();
    if (len > r.remaining) fail(SmgErrorCode.TRUNCATED, `chunk ${tag} declares ${len} bytes but only ${r.remaining} remain`);
    const payloadStart = r.pos;
    const payload = r.bytes(len);
    const stored = r.u32();
    const actual = crc32(bytes, start, payloadStart + len);
    if (stored !== actual) fail(SmgErrorCode.CRC_MISMATCH, `CRC mismatch in chunk ${tag} at offset ${start}`);
    const critical = tag.charCodeAt(0) >= 65 && tag.charCodeAt(0) <= 90;
    if (chunks.length === 0 && tag !== ChunkTag.HEAD) fail(SmgErrorCode.CHUNK_ORDER, 'first chunk must be HEAD');
    if (critical && !KNOWN_CRITICAL.has(tag)) fail(SmgErrorCode.UNKNOWN_CRITICAL_CHUNK, `unknown critical chunk "${tag}"`);
    chunks.push({ tag, offset: start, length: len, payload, critical });
    if (tag === ChunkTag.HEAD) {
      if (header) fail(SmgErrorCode.CHUNK_ORDER, 'duplicate HEAD chunk');
      header = parseHeader(payload);
    } else if (tag === ChunkTag.DATA) {
      if (data) fail(SmgErrorCode.CHUNK_ORDER, 'duplicate DATA chunk');
      data = payload;
    } else if (tag === ChunkTag.TAIL) {
      if (len !== 0) fail(SmgErrorCode.CORRUPT_PAYLOAD, 'TAIL chunk must be empty');
      if (!data) fail(SmgErrorCode.CHUNK_ORDER, 'TAIL before DATA');
      sawTail = true;
    }
  }
  if (!header) fail(SmgErrorCode.TRUNCATED, 'missing HEAD chunk (file truncated?)');
  if (!data) fail(SmgErrorCode.TRUNCATED, 'missing DATA chunk');
  if (!sawTail) fail(SmgErrorCode.TRUNCATED, 'missing TAIL chunk (file truncated?)');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (header.width > lim.maxDimension || header.height > lim.maxDimension) {
    fail(SmgErrorCode.LIMIT_EXCEEDED, `image ${header.width}×${header.height} exceeds the maximum dimension ${lim.maxDimension}`);
  }
  if (header.width * header.height > lim.maxPixels) {
    fail(SmgErrorCode.LIMIT_EXCEEDED, `image has ${header.width * header.height} pixels; limit is ${lim.maxPixels}`);
  }
  return { versionMajor: major, versionMinor: minor, header, chunks, data };
}

function isSmgPrefix(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, SIGNATURE.length); i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

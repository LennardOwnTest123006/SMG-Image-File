import { readContainer, ChunkTag, type DecodeLimits, type ParsedContainer } from './container.ts';
import { crc32 } from './crc32.ts';
import { decodeLossless } from './codecs/lossless.ts';
import { decodePalette } from './codecs/palette.ts';
import { decodeWavelet } from './codecs/wavelet.ts';
import { fail, SmgErrorCode } from './errors.ts';
import type { RgbaImage } from './image.ts';
import { decodeChecksum, decodeProfile, decodeText, type SmgMetadata } from './metadata.ts';
import { CODEC_NAMES, CodecId, COLOR_MODEL_NAMES, HeadFlags, modelHasAlpha, modelIsGray } from './types.ts';

export interface DecodeOptions extends DecodeLimits {
  /** Verify the stored pixel checksum when present (default true). */
  verifyChecksum?: boolean;
}

export interface SmgInfo {
  versionMajor: number;
  versionMinor: number;
  width: number;
  height: number;
  colorModel: number;
  colorModelName: string;
  hasAlpha: boolean;
  bitDepth: number;
  codec: number;
  codecName: string;
  flags: number;
  exact: boolean;
  quantized: boolean;
  visuallyLossless: boolean;
  quality: number | null;
  fileBytes: number;
  payloadBytes: number;
  metadata: SmgMetadata;
  checksum: number | null;
  chunks: Array<{ tag: string; offset: number; length: number; critical: boolean }>;
}

function buildInfo(c: ParsedContainer, fileBytes: number): SmgInfo {
  const h = c.header;
  const md: SmgMetadata = {};
  let checksum: number | null = null;
  for (const ch of c.chunks) {
    switch (ch.tag) {
      case ChunkTag.META:
        md.text = decodeText(ch.payload);
        break;
      case ChunkTag.PROFILE: {
        const p = decodeProfile(ch.payload);
        if (p) md.icc = p;
        break;
      }
      case ChunkTag.EXIF:
        md.exif = ch.payload.slice();
        break;
      case ChunkTag.XMP:
        md.xmp = new TextDecoder().decode(ch.payload);
        break;
      case ChunkTag.CHECKSUM:
        checksum = decodeChecksum(ch.payload) ?? null;
        break;
    }
  }
  return {
    versionMajor: c.versionMajor,
    versionMinor: c.versionMinor,
    width: h.width,
    height: h.height,
    colorModel: h.colorModel,
    colorModelName: COLOR_MODEL_NAMES[h.colorModel] ?? `unknown (${h.colorModel})`,
    hasAlpha: modelHasAlpha(h.colorModel),
    bitDepth: h.bitDepth,
    codec: h.codec,
    codecName: CODEC_NAMES[h.codec] ?? `unknown (${h.codec})`,
    flags: h.flags,
    exact: (h.flags & HeadFlags.EXACT) !== 0,
    quantized: (h.flags & HeadFlags.QUANTIZED) !== 0,
    visuallyLossless: (h.flags & HeadFlags.CLEANED_TRANSPARENT) !== 0,
    quality: h.quality === 255 ? null : h.quality,
    fileBytes,
    payloadBytes: c.data.length,
    metadata: md,
    checksum,
    chunks: c.chunks.map((ch) => ({ tag: ch.tag, offset: ch.offset, length: ch.length, critical: ch.critical })),
  };
}

/** Validate the file structure and read header + metadata without decoding pixels. */
export function inspect(bytes: Uint8Array, options: DecodeLimits = {}): SmgInfo {
  return buildInfo(readContainer(bytes, options), bytes.length);
}

export interface DecodeResult {
  image: RgbaImage & { data: Uint8Array };
  info: SmgInfo;
}

/** Decode an SMG file to 8-bit RGBA. */
export function decode(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  const c = readContainer(bytes, options);
  const info = buildInfo(c, bytes.length);
  const { width: w, height: h, colorModel: m, codec } = c.header;
  let data: Uint8Array;
  switch (codec) {
    case CodecId.LOSSLESS:
      data = decodeLossless(c.data, w, h, m);
      break;
    case CodecId.PALETTE:
      data = decodePalette(c.data, w, h, m);
      break;
    case CodecId.WAVELET:
      data = decodeWavelet(c.data, w, h, modelHasAlpha(m), modelIsGray(m));
      break;
    default:
      fail(SmgErrorCode.UNSUPPORTED_CODEC, `codec ${codec} is not supported by this decoder`);
  }
  if ((options.verifyChecksum ?? true) && info.checksum !== null) {
    const actual = crc32(data);
    if (actual !== info.checksum) fail(SmgErrorCode.CHECKSUM_MISMATCH, 'decoded pixels do not match the stored checksum');
  }
  return { image: { width: w, height: h, data }, info };
}

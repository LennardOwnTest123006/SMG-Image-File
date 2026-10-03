/**
 * @smg/codec — reference implementation of the SMG image format.
 *
 *   import { encode, decode, inspect } from '@smg/codec';
 *   const { bytes, info } = encode({ width, height, data }, { preset: 'photo' });
 *   const { image } = decode(bytes);
 */
export { encode, PRESETS } from './encoder.ts';
export type { EncodeOptions, EncodeResult, EncodeInfo, CandidateReport, SmgMode, SmgPreset } from './encoder.ts';
export { decode, inspect } from './decoder.ts';
export type { DecodeOptions, DecodeResult, SmgInfo } from './decoder.ts';
export { isSmg, SIGNATURE, VERSION_MAJOR, VERSION_MINOR, MIME_TYPE, FILE_EXTENSION, DEFAULT_LIMITS, MAX_FORMAT_DIMENSION } from './container.ts';
export type { DecodeLimits, Header } from './container.ts';
export { SmgError, SmgErrorCode, isSmgError } from './errors.ts';
export { analyzeImage, assertImage, createImage, pixelsEqual, countDifferentPixels, pixelHash } from './image.ts';
export type { RgbaImage, ImageAnalysis } from './image.ts';
export type { SmgMetadata } from './metadata.ts';
export { psnr, ssim, mse, bitsPerPixel } from './metrics.ts';
export { quantizeImage } from './quantize.ts';
export { formatBytes, compressionStats, describeStats } from './stats.ts';
export type { CompressionStats } from './stats.ts';
export { ColorModel, CodecId, HeadFlags, CODEC_NAMES, COLOR_MODEL_NAMES } from './types.ts';
export { stepForQuality, qualityForStep } from './codecs/wavelet.ts';
export { crc32 } from './crc32.ts';

export const SMG_CODEC_VERSION = '1.0.0';

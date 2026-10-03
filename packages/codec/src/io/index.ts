/**
 * @smg/codec/io — pure-TypeScript readers/writers for conventional formats
 * used around SMG (PNG, BMP, GIF) plus format sniffing and metadata helpers.
 * JPEG/WebP/AVIF pixel decoding is delegated to the platform (browser) or to
 * optional native libraries (CLI).
 */
export { decodePng, encodePng, PNG_SIGNATURE } from './png.ts';
export type { PngDecodeResult, PngEncodeOptions } from './png.ts';
export { decodeBmp, encodeBmp } from './bmp.ts';
export { decodeGif } from './gif.ts';
export type { GifDecodeResult, GifFrame, GifDecodeOptions } from './gif.ts';
export { detectFormat, FORMAT_LABELS, FORMAT_MIME } from './detect.ts';
export type { ImageFormat } from './detect.ts';
export { readJpegMetadata, exifOrientation } from './jpeg-meta.ts';
export type { JpegMetadata } from './jpeg-meta.ts';
export { applyOrientation, resizeImage, cropImage, flipImage, rotateImage90 } from './transform.ts';
export { createZip } from './zip.ts';
export type { ZipEntry } from './zip.ts';

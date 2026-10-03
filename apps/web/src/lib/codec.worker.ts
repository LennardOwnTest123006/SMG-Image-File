/// <reference lib="webworker" />
/**
 * Codec worker: runs all CPU-heavy SMG work off the main thread.
 * Messages carry transferable ArrayBuffers; results are posted back the same way.
 */
import { decode, encode, inspect, isSmgError, psnr, ssim, pixelHash, type EncodeOptions, type RgbaImage } from '@smg/codec';
import { decodeBmp, decodeGif, decodePng, detectFormat, encodePng, encodeBmp, resizeImage } from '@smg/codec/io';
import type { WorkerRequest, WorkerResponse, WireImage } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const toImage = (w: WireImage): RgbaImage & { data: Uint8Array } => ({ width: w.width, height: w.height, data: new Uint8Array(w.data) });
const toWire = (img: RgbaImage): WireImage => {
  const d = img.data instanceof Uint8Array && img.data.byteOffset === 0 && img.data.byteLength === img.data.buffer.byteLength ? img.data : new Uint8Array(img.data);
  return { width: img.width, height: img.height, data: d.buffer as ArrayBuffer };
};

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const { id } = req;
  try {
    switch (req.type) {
      case 'encode': {
        const img = toImage(req.image);
        const opts: EncodeOptions = {
          ...req.options,
          onProgress: (p, stage) => post({ id, type: 'progress', progress: p, stage }),
        };
        const r = encode(img, opts);
        const buf = r.bytes.buffer as ArrayBuffer;
        let metrics: { psnr: number; ssim: number } | undefined;
        if (req.withMetrics && !r.info.exact) {
          post({ id, type: 'progress', progress: 1, stage: 'Measuring quality' });
          const d = decode(r.bytes).image;
          metrics = { psnr: psnr(img, d), ssim: ssim(img, d) };
        }
        post({ id, type: 'result', result: { bytes: buf, info: r.info, metrics } }, [buf]);
        break;
      }
      case 'decode': {
        const r = decode(new Uint8Array(req.bytes), req.limits);
        const wire = toWire(r.image);
        post({ id, type: 'result', result: { image: wire, info: r.info } }, [wire.data]);
        break;
      }
      case 'inspect': {
        post({ id, type: 'result', result: inspect(new Uint8Array(req.bytes), req.limits) });
        break;
      }
      case 'decodeFile': {
        // Pure-JS decoders for formats where exact pixels matter (PNG/BMP/GIF/SMG).
        const bytes = new Uint8Array(req.bytes);
        const fmt = detectFormat(bytes);
        const maxPixels = req.maxPixels;
        if (fmt === 'png') {
          const r = decodePng(bytes, maxPixels);
          const wire = toWire(r.image);
          const notes = r.reducedPrecision ? ['16-bit PNG reduced to 8 bits per channel.'] : [];
          const text = Object.keys(r.text).length ? r.text : undefined;
          post({ id, type: 'result', result: { format: fmt, frames: [wire], metadata: { icc: r.icc, exif: r.exif, text }, notes } }, [wire.data]);
        } else if (fmt === 'bmp') {
          const wire = toWire(decodeBmp(bytes, maxPixels));
          post({ id, type: 'result', result: { format: fmt, frames: [wire], metadata: {}, notes: [] } }, [wire.data]);
        } else if (fmt === 'gif') {
          const g = decodeGif(bytes, { maxPixels, maxFrames: req.maxFrames ?? 300 });
          const frames = g.frames.map((f) => toWire(f.image));
          post({ id, type: 'result', result: { format: fmt, frames, delays: g.frames.map((f) => f.delayMs), metadata: {}, notes: g.frames.length > 1 ? [`Animated GIF with ${g.frames.length} frames.`] : [] } }, frames.map((f) => f.data));
        } else if (fmt === 'smg') {
          const r = decode(bytes, { maxPixels });
          const wire = toWire(r.image);
          post({ id, type: 'result', result: { format: fmt, frames: [wire], metadata: r.info.metadata, notes: [], smgInfo: r.info } }, [wire.data]);
        } else {
          throw new Error(`decodeFile: unsupported format ${fmt}`);
        }
        break;
      }
      case 'encodePng': {
        const png = encodePng(toImage(req.image), { text: req.text });
        post({ id, type: 'result', result: png.buffer }, [png.buffer as ArrayBuffer]);
        break;
      }
      case 'encodeBmp': {
        const bmp = encodeBmp(toImage(req.image));
        post({ id, type: 'result', result: bmp.buffer }, [bmp.buffer as ArrayBuffer]);
        break;
      }
      case 'metrics': {
        const a = toImage(req.a), b = toImage(req.b);
        post({ id, type: 'result', result: { psnr: psnr(a, b), ssim: ssim(a, b) } });
        break;
      }
      case 'hash': {
        post({ id, type: 'result', result: pixelHash(toImage(req.image)) });
        break;
      }
      case 'resize': {
        const r = resizeImage(toImage(req.image), req.width, req.height);
        const wire = toWire(r);
        post({ id, type: 'result', result: wire }, [wire.data]);
        break;
      }
      default:
        throw new Error('unknown request');
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    post({ id, type: 'error', code: isSmgError(e) ? (err.code ?? 'ERROR') : 'ERROR', message: err.message ?? String(e) });
  }
};

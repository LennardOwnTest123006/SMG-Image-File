import type { DecodeLimits, EncodeInfo, EncodeOptions, SmgInfo, SmgMetadata } from '@smg/codec';

/** RGBA image as sent between threads (buffer is transferred). */
export interface WireImage {
  width: number;
  height: number;
  data: ArrayBuffer;
}

export type WorkerEncodeOptions = Omit<EncodeOptions, 'onProgress' | 'signal'>;

export type WorkerRequest =
  | { id: number; type: 'encode'; image: WireImage; options: WorkerEncodeOptions; withMetrics?: boolean }
  | { id: number; type: 'decode'; bytes: ArrayBuffer; limits?: DecodeLimits }
  | { id: number; type: 'inspect'; bytes: ArrayBuffer; limits?: DecodeLimits }
  | { id: number; type: 'decodeFile'; bytes: ArrayBuffer; maxPixels: number; maxFrames?: number }
  | { id: number; type: 'encodePng'; image: WireImage; text?: Record<string, string> }
  | { id: number; type: 'encodeBmp'; image: WireImage }
  | { id: number; type: 'metrics'; a: WireImage; b: WireImage }
  | { id: number; type: 'hash'; image: WireImage }
  | { id: number; type: 'resize'; image: WireImage; width: number; height: number };

/** Omit that distributes over union members. */
export type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'result'; result: any }
  | { id: number; type: 'error'; code: string; message: string };

export interface EncodeResultWire {
  bytes: ArrayBuffer;
  info: EncodeInfo;
  metrics?: { psnr: number; ssim: number };
}

export interface DecodeFileResult {
  format: string;
  frames: WireImage[];
  delays?: number[];
  metadata: SmgMetadata;
  notes: string[];
  smgInfo?: SmgInfo;
}

// Optional typed alias for consumers (no runtime code).
export type { SmgInfo, EncodeInfo };

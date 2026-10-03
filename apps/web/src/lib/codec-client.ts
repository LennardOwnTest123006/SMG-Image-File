/**
 * Promise-based client for a small pool of codec workers.
 * Each task can report progress and be cancelled; cancelling terminates the
 * worker running it (a hard stop) and replaces it with a fresh one.
 */
import type { DecodeLimits, RgbaImage, SmgInfo } from '@smg/codec';
import type { DecodeFileResult, EncodeResultWire, RequestBody, WireImage, WorkerEncodeOptions, WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number, stage: string) => void;
  worker: Slot;
};

interface Slot {
  worker: Worker;
  busy: number;
}

export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class CancelledError extends TaskError {
  constructor() {
    super('SMG_E_ABORTED', 'Cancelled');
  }
}

let nextId = 1;

function makeWorker(): Worker {
  return new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module' });
}

class Pool {
  private slots: Slot[] = [];
  private pending = new Map<number, Pending>();
  private readonly size: number;

  constructor() {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    this.size = Math.max(1, Math.min(4, hc - 1));
  }

  private spawn(): Slot {
    const slot: Slot = { worker: makeWorker(), busy: 0 };
    slot.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    slot.worker.onerror = (ev) => {
      ev.preventDefault();
      // Fail every task on this worker and replace it.
      for (const [id, p] of this.pending) if (p.worker === slot) { this.pending.delete(id); p.reject(new TaskError('WORKER', ev.message || 'Worker crashed (out of memory?)')); }
      this.replace(slot);
    };
    this.slots.push(slot);
    return slot;
  }

  private replace(slot: Slot): void {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
  }

  private pick(): Slot {
    let best = this.slots.reduce<Slot | null>((a, s) => (!a || s.busy < a.busy ? s : a), null);
    if (!best || (best.busy > 0 && this.slots.length < this.size)) best = this.spawn();
    return best;
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.(msg.progress, msg.stage);
      return;
    }
    this.pending.delete(msg.id);
    p.worker.busy--;
    if (msg.type === 'result') p.resolve(msg.result);
    else p.reject(new TaskError(msg.code, msg.message));
  }

  run<T>(req: RequestBody, transfer: Transferable[] = [], opts: { onProgress?: (p: number, s: string) => void; signal?: AbortSignal } = {}): Promise<T> {
    if (opts.signal?.aborted) return Promise.reject(new CancelledError());
    const id = nextId++;
    const slot = this.pick();
    slot.busy++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress, worker: slot });
      opts.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          // Hard-cancel: kill the worker and fail all of its tasks.
          for (const [pid, p] of this.pending) if (p.worker === slot) { this.pending.delete(pid); p.reject(new CancelledError()); }
          this.replace(slot);
        },
        { once: true },
      );
      slot.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
    });
  }
}

let pool: Pool | null = null;
const getPool = () => (pool ??= new Pool());

/** Copy an image into a transferable wire object (the caller keeps its copy). */
export function toWire(img: RgbaImage, transfer = false): WireImage {
  if (transfer && img.data instanceof Uint8Array && img.data.byteOffset === 0 && img.data.byteLength === img.data.buffer.byteLength) {
    return { width: img.width, height: img.height, data: img.data.buffer as ArrayBuffer };
  }
  return { width: img.width, height: img.height, data: new Uint8Array(img.data).buffer };
}

export function fromWire(w: WireImage): RgbaImage & { data: Uint8Array } {
  return { width: w.width, height: w.height, data: new Uint8Array(w.data) };
}

export interface TaskOptions {
  onProgress?: (p: number, stage: string) => void;
  signal?: AbortSignal;
}

export const codec = {
  async encode(img: RgbaImage, options: WorkerEncodeOptions, opts: TaskOptions & { withMetrics?: boolean } = {}) {
    const w = toWire(img);
    const r = await getPool().run<EncodeResultWire>({ type: 'encode', image: w, options, withMetrics: opts.withMetrics }, [w.data], opts);
    return { bytes: new Uint8Array(r.bytes), info: r.info, metrics: r.metrics };
  },
  async decode(bytes: Uint8Array, limits?: DecodeLimits, opts: TaskOptions = {}) {
    const buf = bytes.slice().buffer;
    const r = await getPool().run<{ image: WireImage; info: SmgInfo }>({ type: 'decode', bytes: buf, limits }, [buf], opts);
    return { image: fromWire(r.image), info: r.info };
  },
  async inspect(bytes: Uint8Array, limits?: DecodeLimits) {
    const buf = bytes.slice().buffer;
    return getPool().run<SmgInfo>({ type: 'inspect', bytes: buf, limits }, [buf]);
  },
  async decodeFile(bytes: Uint8Array, maxPixels: number, opts: TaskOptions = {}) {
    const buf = bytes.slice().buffer;
    return getPool().run<DecodeFileResult>({ type: 'decodeFile', bytes: buf, maxPixels }, [buf], opts);
  },
  async encodePng(img: RgbaImage, text?: Record<string, string>) {
    const w = toWire(img);
    return new Uint8Array(await getPool().run<ArrayBuffer>({ type: 'encodePng', image: w, text }, [w.data]));
  },
  async encodeBmp(img: RgbaImage) {
    const w = toWire(img);
    return new Uint8Array(await getPool().run<ArrayBuffer>({ type: 'encodeBmp', image: w }, [w.data]));
  },
  async metrics(a: RgbaImage, b: RgbaImage) {
    const wa = toWire(a), wb = toWire(b);
    return getPool().run<{ psnr: number; ssim: number }>({ type: 'metrics', a: wa, b: wb }, [wa.data, wb.data]);
  },
  async hash(img: RgbaImage) {
    const w = toWire(img);
    return getPool().run<string>({ type: 'hash', image: w }, [w.data]);
  },
  async resize(img: RgbaImage, width: number, height: number) {
    const w = toWire(img);
    return fromWire(await getPool().run<WireImage>({ type: 'resize', image: w, width, height }, [w.data]));
  },
};

/**
 * Studio project persistence.
 *
 *  - `.smgp` project files: JSON with every layer; pixel layers are stored as
 *    lossless SMG (base64). Projects stay fully editable and are distinct from
 *    flattened image exports.
 *  - Autosave: the same structure (raw bytes instead of base64) in IndexedDB,
 *    enabling crash recovery and a "recent projects" list. Local only.
 */
import { codec } from '../lib/codec-client.ts';
import { idb, STORES } from '../lib/idb.ts';
import { makeCanvas, uid, type Doc, type Layer } from './model.ts';
import { docThumb } from './render.ts';

export const PROJECT_FORMAT = 'smg-studio-project';
export const PROJECT_VERSION = 1;

type PixelRef = { width: number; height: number; smg: Uint8Array | string };
type StoredLayer = Omit<Layer, 'canvas'> & { pixels?: PixelRef };

export interface StoredDoc extends Omit<Doc, 'layers'> {
  layers: StoredLayer[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: number;
  width: number;
  height: number;
  thumb: string;
  doc: StoredDoc;
}

// Canvases in committed documents are never mutated, so encoded bytes can be cached per canvas.
const cache = new WeakMap<HTMLCanvasElement, Uint8Array>();

async function encodeCanvas(c: HTMLCanvasElement): Promise<Uint8Array> {
  const hit = cache.get(c);
  if (hit) return hit;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  const r = await codec.encode({ width: c.width, height: c.height, data: new Uint8Array(d.data.buffer) }, { mode: 'lossless', effort: 2 });
  cache.set(c, r.bytes);
  return r.bytes;
}

async function decodeToCanvas(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const { image } = await codec.decode(bytes);
  const c = makeCanvas(image.width, image.height);
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer as ArrayBuffer), image.width, image.height), 0, 0);
  cache.set(c, bytes);
  return c;
}

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function serializeDoc(doc: Doc, base64: boolean): Promise<StoredDoc> {
  const layers: StoredLayer[] = [];
  for (const l of doc.layers) {
    if (l.kind === 'raster' || l.kind === 'image') {
      const { canvas, ...rest } = l;
      const bytes = await encodeCanvas(canvas);
      layers.push({ ...rest, pixels: { width: canvas.width, height: canvas.height, smg: base64 ? toBase64(bytes) : bytes } } as StoredLayer);
    } else layers.push({ ...l });
  }
  return { ...doc, layers };
}

export async function deserializeDoc(s: StoredDoc): Promise<Doc> {
  if (!s || typeof s.width !== 'number' || typeof s.height !== 'number' || !Array.isArray(s.layers)) throw new Error('Invalid project data');
  if (s.width < 1 || s.height < 1 || s.width * s.height > 64_000_000) throw new Error('Project canvas size is out of range');
  const layers: Layer[] = [];
  for (const l of s.layers) {
    if (l.kind === 'raster' || l.kind === 'image') {
      const p = (l as StoredLayer).pixels;
      if (!p) throw new Error(`Layer "${l.name}" has no pixel data`);
      const bytes = typeof p.smg === 'string' ? fromBase64(p.smg) : p.smg;
      const canvas = await decodeToCanvas(bytes);
      const { pixels: _p, ...rest } = l as StoredLayer;
      void _p;
      layers.push({ ...(rest as object), canvas } as Layer);
    } else layers.push({ ...(l as Layer) });
  }
  return { ...s, layers } as Doc;
}

export async function exportProjectFile(doc: Doc): Promise<Blob> {
  const stored = await serializeDoc(doc, true);
  const json = JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, app: `SMG Studio ${__APP_VERSION__}`, savedAt: new Date().toISOString(), doc: stored });
  return new Blob([json], { type: 'application/x-smg-project+json' });
}

export async function importProjectFile(file: File): Promise<Doc> {
  let parsed: { format?: string; version?: number; doc?: StoredDoc };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('Not a valid SMG Studio project (.smgp) file');
  }
  if (parsed.format !== PROJECT_FORMAT) throw new Error('Not an SMG Studio project file');
  if ((parsed.version ?? 0) > PROJECT_VERSION) throw new Error(`Project version ${parsed.version} is newer than this Studio supports`);
  return deserializeDoc(parsed.doc!);
}

// ---------- autosave ----------

export async function autosave(doc: Doc): Promise<void> {
  const stored = await serializeDoc(doc, false);
  const rec: ProjectRecord = { id: doc.id, name: doc.name, updatedAt: doc.updatedAt, width: doc.width, height: doc.height, thumb: docThumb(doc, 160), doc: stored };
  await idb.put(STORES.projects, rec);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  try {
    const all = await idb.all<ProjectRecord>(STORES.projects);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<Doc | null> {
  const rec = await idb.get<ProjectRecord>(STORES.projects, id);
  return rec ? deserializeDoc(rec.doc) : null;
}

export async function deleteProject(id: string): Promise<void> {
  await idb.delete(STORES.projects, id);
}

export function duplicateDoc(doc: Doc): Doc {
  const now = Date.now();
  return { ...doc, id: uid('d'), name: `${doc.name} (copy)`, createdAt: now, updatedAt: now, layers: doc.layers.map((l) => ({ ...l, id: uid() })) };
}

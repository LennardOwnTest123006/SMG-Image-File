import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon.tsx';
import { LogoMark, Range, Segmented, useToast } from '../components/ui.tsx';
import { saveBlob } from '../lib/download.ts';
import { getPref, setPref } from '../lib/idb.ts';
import { cleanError, loadFile } from '../lib/images.ts';
import { ExportDialog, NewDocDialog, ResizeDialog, ShortcutsDialog } from './dialogs.tsx';
import { cloneCanvas, hitTest, layerBox, makeCanvas, newDoc, newRaster, newShape, newText, replaceLayer, toLocal, uid, type Box, type Doc, type Layer, type ShapeKind } from './model.ts';
import { alignLayer, canvasSizeDoc, compositeData, cropDoc, flipDoc, imageLayerFrom, mergeDown, rasterize, resizeDoc, rotateDoc } from './ops.ts';
import { AdjustPanel, isAdjusted, LayersPanel, NO_ADJUST_STATE, PropertiesPanel, toHex, type AdjustState } from './panels.tsx';
import { autosave, deleteProject, duplicateDoc, exportProjectFile, importProjectFile, listProjects, loadProject, type ProjectRecord } from './project.ts';
import { brushTip, floodFill, floodMask, hexToRgba, paintMask, pixelLine, processCanvas, rgbToHex, stampLine } from './raster.ts';
import { renderDoc, type LiveStroke } from './render.ts';
import { TEMPLATES } from './templates.ts';
import './studio.css';

type ToolId = 'move' | 'hand' | 'brush' | 'pencil' | 'eraser' | 'fill' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eyedropper' | 'crop';

interface ToolOpts {
  color: string;
  color2: string;
  size: number;
  hardness: number;
  opacity: number;
  tolerance: number;
  sampleAll: boolean;
  shapeFill: boolean;
  shapeStroke: boolean;
  strokeWidth: number;
  radius: number;
  fontSize: number;
}

const DEFAULT_OPTS: ToolOpts = { color: '#6a5cff', color2: '#ffffff', size: 18, hardness: 0.7, opacity: 1, tolerance: 32, sampleAll: true, shapeFill: true, shapeStroke: false, strokeWidth: 6, radius: 0, fontSize: 64 };

const TOOLS: Array<{ id: ToolId; icon: IconName; label: string; key: string }> = [
  { id: 'move', icon: 'move', label: 'Move / select', key: 'V' },
  { id: 'hand', icon: 'hand', label: 'Pan', key: 'H' },
  { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil', key: 'P' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', icon: 'fill', label: 'Fill', key: 'G' },
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'line', icon: 'line', label: 'Line', key: 'L' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow', key: 'A' },
  { id: 'text', icon: 'text', label: 'Text', key: 'T' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'I' },
  { id: 'crop', icon: 'crop', label: 'Crop', key: 'C' },
];

const HISTORY_LIMIT = 40;
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'rot' | 'p1' | 'p2';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'move'; base: Doc; id: string; sx: number; sy: number; x0: number; y0: number; box: Box; moved: boolean }
  | { kind: 'handle'; base: Doc; id: string; handle: Handle; layer: Layer }
  | { kind: 'stroke'; base: Doc; id: string; canvas: HTMLCanvasElement; last: [number, number]; tip: HTMLCanvasElement | null }
  | { kind: 'shape'; base: Doc; id: string; sx: number; sy: number; shape: ShapeKind }
  | { kind: 'crop'; sx: number; sy: number }
  | { kind: 'pinch'; d0: number; z0: number; mx: number; my: number; panX: number; panY: number };

function initialDoc(): Doc {
  return newDoc(1280, 720, '#ffffff', 'Untitled design');
}

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export default function Studio() {
  const toast = useToast();
  const [doc, setDocState] = useState<Doc>(initialDoc);
  const docRef = useRef(doc);
  const undo = useRef<Doc[]>([]);
  const redo = useRef<Doc[]>([]);
  const [, setHistVer] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(doc.layers[0]?.id ?? null);
  const [tool, setToolState] = useState<ToolId>('brush');
  const [opts, setOpts] = useState<ToolOpts>(DEFAULT_OPTS);
  const [view, setViewState] = useState({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  const [grid, setGrid] = useState({ show: false, size: 32, snap: true });
  const [crop, setCropState] = useState<Box | null>(null);
  const cropRef = useRef<Box | null>(null);
  const [adjust, setAdjust] = useState<AdjustState>(NO_ADJUST_STATE);
  const [adjPreview, setAdjPreview] = useState<HTMLCanvasElement | null>(null);
  const [adjBusy, setAdjBusy] = useState(false);
  const [rightTab, setRightTab] = useState<'props' | 'adjust'>('props');
  const [dialog, setDialog] = useState<null | 'new' | 'export' | 'resize' | 'canvas' | 'shortcuts'>(null);
  const [recent, setRecent] = useState<ProjectRecord[]>([]);
  const [recovery, setRecovery] = useState<ProjectRecord | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSaved, setLastSaved] = useState<number | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [panelsOpen, setPanelsOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 900);
  const [spaceDown, setSpaceDown] = useState(false);

  const viewport = useRef<HTMLDivElement>(null);
  const docCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<Drag | null>(null);
  const live = useRef<LiveStroke | null>(null);
  const guides = useRef<Array<{ v: boolean; at: number }>>([]);
  const pointers = useRef(new Map<number, [number, number]>());
  const hover = useRef<[number, number] | null>(null);
  const coalesce = useRef<{ key: string; t: number } | null>(null);
  const saveTimer = useRef<number>(0);
  const rafId = useRef(0);

  const selected = doc.layers.find((l) => l.id === selectedId) ?? null;
  const st = useRef({ selectedId, tool, opts, grid, adjPreview, adjust, spaceDown });
  st.current = { selectedId, tool, opts, grid, adjPreview, adjust, spaceDown };

  // ---------------- rendering ----------------
  const draw = useCallback(() => {
    const d = docRef.current;
    const c = docCanvas.current, o = overlay.current, vp = viewport.current;
    if (!c || !o || !vp) return;
    if (c.width !== d.width || c.height !== d.height) {
      c.width = d.width;
      c.height = d.height;
    }
    const s = st.current;
    const overrides = new Map<string, HTMLCanvasElement>();
    let compare = null;
    if (s.adjPreview && s.selectedId) {
      overrides.set(s.selectedId, s.adjPreview);
      const l = d.layers.find((x) => x.id === s.selectedId);
      if (s.adjust.compare && l && (l.kind === 'raster' || l.kind === 'image')) compare = { layerId: l.id, before: l.canvas, split: s.adjust.split };
    }
    renderDoc(c.getContext('2d')!, d, { live: live.current, overrides, compare });

    // overlay (screen space)
    const dpr = window.devicePixelRatio || 1;
    const vw = vp.clientWidth, vh = vp.clientHeight;
    if (o.width !== Math.round(vw * dpr) || o.height !== Math.round(vh * dpr)) {
      o.width = Math.round(vw * dpr);
      o.height = Math.round(vh * dpr);
      o.style.width = `${vw}px`;
      o.style.height = `${vh}px`;
    }
    const ctx = o.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    const v = viewRef.current;
    const sx = (x: number) => v.panX + x * v.zoom;
    const sy = (y: number) => v.panY + y * v.zoom;
    if (s.grid.show) {
      ctx.strokeStyle = 'rgba(106,92,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= d.width; x += s.grid.size) { ctx.moveTo(Math.round(sx(x)) + 0.5, sy(0)); ctx.lineTo(Math.round(sx(x)) + 0.5, sy(d.height)); }
      for (let y = 0; y <= d.height; y += s.grid.size) { ctx.moveTo(sx(0), Math.round(sy(y)) + 0.5); ctx.lineTo(sx(d.width), Math.round(sy(y)) + 0.5); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(168,85,247,0.45)';
      ctx.beginPath();
      ctx.moveTo(sx(d.width / 2), sy(0)); ctx.lineTo(sx(d.width / 2), sy(d.height));
      ctx.moveTo(sx(0), sy(d.height / 2)); ctx.lineTo(sx(d.width), sy(d.height / 2));
      ctx.stroke();
    }
    // selection
    const sel = d.layers.find((l) => l.id === s.selectedId);
    if (sel && sel.visible && s.tool !== 'crop') {
      const b = layerBox(sel);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      ctx.save();
      ctx.translate(sx(cx), sy(cy));
      ctx.rotate((sel.rotation * Math.PI) / 180);
      ctx.strokeStyle = '#8b7bff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(sel.kind === 'raster' ? [5, 4] : []);
      const hw = (b.w * v.zoom) / 2, hh = (b.h * v.zoom) / 2;
      if (sel.kind === 'shape' && (sel.shape === 'line' || sel.shape === 'arrow')) {
        ctx.restore();
        for (const [px, py] of [[sel.x, sel.y], [sel.x + sel.w, sel.y + sel.h]]) {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#6a5cff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx(px), sy(py), 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        ctx.setLineDash([]);
        if (sel.kind !== 'raster' && s.tool === 'move' && !sel.locked) {
          for (const [hx, hy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#6a5cff';
            ctx.lineWidth = 2;
            ctx.fillRect(hx - 5, hy - 5, 10, 10);
            ctx.strokeRect(hx - 5, hy - 5, 10, 10);
          }
          ctx.beginPath();
          ctx.moveTo(0, -hh);
          ctx.lineTo(0, -hh - 22);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, -hh - 28, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    // snapping guides
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const g of guides.current) {
      ctx.beginPath();
      if (g.v) { ctx.moveTo(sx(g.at) + 0.5, 0); ctx.lineTo(sx(g.at) + 0.5, vh); } else { ctx.moveTo(0, sy(g.at) + 0.5); ctx.lineTo(vw, sy(g.at) + 0.5); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // crop
    const cr = cropRef.current;
    if (s.tool === 'crop' && cr) {
      ctx.fillStyle = 'rgba(3,4,10,0.55)';
      ctx.beginPath();
      ctx.rect(sx(0), sy(0), d.width * v.zoom, d.height * v.zoom);
      ctx.rect(sx(cr.x), sy(cr.y), cr.w * v.zoom, cr.h * v.zoom);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx(cr.x), sy(cr.y), cr.w * v.zoom, cr.h * v.zoom);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      for (let k = 1; k < 3; k++) {
        ctx.moveTo(sx(cr.x + (cr.w * k) / 3), sy(cr.y)); ctx.lineTo(sx(cr.x + (cr.w * k) / 3), sy(cr.y + cr.h));
        ctx.moveTo(sx(cr.x), sy(cr.y + (cr.h * k) / 3)); ctx.lineTo(sx(cr.x + cr.w), sy(cr.y + (cr.h * k) / 3));
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 12px Inter Variable, sans-serif';
      ctx.fillText(`${Math.round(cr.w)} × ${Math.round(cr.h)}`, sx(cr.x) + 6, sy(cr.y) - 8);
    }
    // brush cursor
    const hv = hover.current;
    if (hv && (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'pencil') && !s.spaceDown) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx(hv[0]), sy(hv[1]), Math.max(2, (s.opts.size / 2) * v.zoom), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(sx(hv[0]), sy(hv[1]), Math.max(2, (s.opts.size / 2) * v.zoom) + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, []);

  const requestRender = useCallback(() => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    requestRender();
  });

  // ---------------- state helpers ----------------
  const setView = useCallback((v: { zoom: number; panX: number; panY: number }) => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  const setCrop = (b: Box | null) => {
    cropRef.current = b;
    setCropState(b);
  };

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await autosave(docRef.current);
        await setPref('studio.current', docRef.current.id);
        setSaveState('saved');
        setLastSaved(Date.now());
      } catch {
        setSaveState('error');
      }
    }, 1200);
  }, []);

  /** Replace the document without recording history (used during drags). */
  const setTransient = useCallback((d: Doc) => {
    docRef.current = d;
    requestRender();
  }, [requestRender]);

  const commit = useCallback((next: Doc, before: Doc = docRef.current) => {
    if (next === before) return;
    undo.current.push(before);
    if (undo.current.length > HISTORY_LIMIT) undo.current.shift();
    redo.current = [];
    coalesce.current = null;
    docRef.current = next;
    setDocState(next);
    setHistVer((v) => v + 1);
    scheduleSave();
  }, [scheduleSave]);

  const replaceDocument = useCallback((d: Doc, keepHistory = false) => {
    if (!keepHistory) {
      undo.current = [];
      redo.current = [];
    }
    docRef.current = d;
    setDocState(d);
    setSelectedId(d.layers[d.layers.length - 1]?.id ?? null);
    setAdjust(NO_ADJUST_STATE);
    setAdjPreview(null);
    setCrop(null);
    setHistVer((v) => v + 1);
  }, []);

  const doUndo = useCallback(() => {
    const prev = undo.current.pop();
    if (!prev) return;
    redo.current.push(docRef.current);
    docRef.current = prev;
    setDocState(prev);
    setHistVer((v) => v + 1);
    coalesce.current = null;
    scheduleSave();
  }, [scheduleSave]);

  const doRedo = useCallback(() => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(docRef.current);
    docRef.current = next;
    setDocState(next);
    setHistVer((v) => v + 1);
    scheduleSave();
  }, [scheduleSave]);

  /** Patch the selected layer; consecutive edits with the same key within 1 s merge into one undo step. */
  const patchLayer = useCallback((id: string, patch: Partial<Layer>, key: string) => {
    const next = replaceLayer(docRef.current, id, patch);
    const k = `${id}:${key}`;
    const now = Date.now();
    if (coalesce.current && coalesce.current.key === k && now - coalesce.current.t < 1000) {
      docRef.current = next;
      setDocState(next);
      coalesce.current.t = now;
      scheduleSave();
    } else {
      commit(next);
      coalesce.current = { key: k, t: now };
    }
  }, [commit, scheduleSave]);

  const fit = useCallback(() => {
    const vp = viewport.current;
    if (!vp) return;
    const d = docRef.current;
    const z = Math.min((vp.clientWidth - 64) / d.width, (vp.clientHeight - 64) / d.height, 8);
    const zoom = Math.max(0.02, z);
    setView({ zoom, panX: (vp.clientWidth - d.width * zoom) / 2, panY: (vp.clientHeight - d.height * zoom) / 2 });
  }, [setView]);

  const zoomAt = useCallback((z: number, ax?: number, ay?: number) => {
    const vp = viewport.current;
    if (!vp) return;
    const v = viewRef.current;
    const zoom = Math.min(32, Math.max(0.02, z));
    const cx = ax ?? vp.clientWidth / 2, cy = ay ?? vp.clientHeight / 2;
    setView({ zoom, panX: cx - ((cx - v.panX) * zoom) / v.zoom, panY: cy - ((cy - v.panY) * zoom) / v.zoom });
  }, [setView]);

  const setTool = useCallback((t: ToolId) => {
    setToolState(t);
    if (t !== 'crop') setCrop(null);
    else setCrop({ x: 0, y: 0, w: docRef.current.width, h: docRef.current.height });
  }, []);

  // fit on mount and when the document size changes
  useEffect(() => {
    fit();
  }, [doc.id, doc.width, doc.height, fit]);
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => requestRender());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [requestRender]);

  // ---------------- recovery & recent projects ----------------
  useEffect(() => {
    (async () => {
      const list = await listProjects();
      setRecent(list);
      const current = await getPref<string | null>('studio.current', null);
      const rec = current ? list.find((p) => p.id === current) : undefined;
      if (rec) setRecovery(rec);
      const saved = await getPref<Partial<ToolOpts>>('studio.opts', {});
      setOpts((o) => ({ ...o, ...saved }));
    })();
    const warn = (e: BeforeUnloadEvent) => {
      if (saveTimer.current && (document.querySelector('[data-save="dirty"]') || document.querySelector('[data-save="saving"]'))) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    setPref('studio.opts', opts);
  }, [opts]);

  const refreshRecent = () => listProjects().then(setRecent);

  // ---------------- adjustments preview ----------------
  useEffect(() => {
    setAdjust(NO_ADJUST_STATE);
    setAdjPreview(null);
  }, [selectedId]);
  useEffect(() => {
    const l = docRef.current.layers.find((x) => x.id === selectedId);
    if (!l || (l.kind !== 'raster' && l.kind !== 'image') || !isAdjusted(adjust)) {
      setAdjPreview(null);
      return;
    }
    setAdjBusy(true);
    const t = setTimeout(() => {
      setAdjPreview(processCanvas(l.canvas, adjust.adj, adjust.filter, adjust.strength));
      setAdjBusy(false);
    }, 90);
    return () => clearTimeout(t);
  }, [adjust.adj, adjust.filter, adjust.strength, selectedId, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyAdjust = () => {
    if (!selected || !adjPreview) return;
    commit(replaceLayer(docRef.current, selected.id, { canvas: adjPreview } as Partial<Layer>));
    setAdjust(NO_ADJUST_STATE);
    setAdjPreview(null);
    toast('Adjustments applied');
  };

  // ---------------- layer operations ----------------
  const insertAbove = useCallback((d: Doc, layer: Layer, aboveId: string | null): Doc => {
    const layers = [...d.layers];
    const i = aboveId ? layers.findIndex((l) => l.id === aboveId) : layers.length - 1;
    layers.splice(i + 1, 0, layer);
    return { ...d, layers, updatedAt: Date.now() };
  }, []);

  const addLayer = () => {
    const d = docRef.current;
    const l = newRaster(d, `Layer ${d.layers.length + 1}`);
    commit(insertAbove(d, l, st.current.selectedId));
    setSelectedId(l.id);
  };

  const duplicateLayer = () => {
    const d = docRef.current;
    const l = d.layers.find((x) => x.id === st.current.selectedId);
    if (!l) return;
    const copy = { ...l, id: uid(), name: `${l.name} copy` } as Layer;
    commit(insertAbove(d, copy, l.id));
    setSelectedId(copy.id);
  };

  const deleteLayer = () => {
    const d = docRef.current;
    const i = d.layers.findIndex((x) => x.id === st.current.selectedId);
    if (i < 0) return;
    const layers = d.layers.filter((_, k) => k !== i);
    commit({ ...d, layers, updatedAt: Date.now() });
    setSelectedId(layers[Math.max(0, i - 1)]?.id ?? null);
  };

  const moveLayer = (id: string, dir: 1 | -1) => {
    const d = docRef.current;
    const i = d.layers.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.layers.length) return;
    const layers = [...d.layers];
    [layers[i], layers[j]] = [layers[j], layers[i]];
    commit({ ...d, layers, updatedAt: Date.now() });
  };

  const reorder = (id: string, to: number) => {
    const d = docRef.current;
    const i = d.layers.findIndex((x) => x.id === id);
    if (i < 0) return;
    const layers = [...d.layers];
    const [l] = layers.splice(i, 1);
    layers.splice(to, 0, l);
    commit({ ...d, layers, updatedAt: Date.now() });
  };

  /** The raster layer to paint on (creates one above the selection if needed). */
  const paintTarget = (): Extract<Layer, { kind: 'raster' }> | null => {
    const d = docRef.current;
    const sel = d.layers.find((x) => x.id === st.current.selectedId);
    if (sel && sel.kind === 'raster') {
      if (sel.locked) {
        toast('This layer is locked.', 'error');
        return null;
      }
      return sel;
    }
    const l = newRaster(d, 'Paint');
    commit(insertAbove(d, l, sel?.id ?? null));
    setSelectedId(l.id);
    st.current.selectedId = l.id;
    return l;
  };

  const docToLayerPixel = (l: Layer & { canvas: HTMLCanvasElement }, px: number, py: number): [number, number] => {
    const [lx, ly] = toLocal(l, px, py);
    const b = layerBox(l);
    let u = ((lx - b.x) / b.w) * l.canvas.width;
    let v = ((ly - b.y) / b.h) * l.canvas.height;
    if (l.flipX) u = l.canvas.width - u;
    if (l.flipY) v = l.canvas.height - v;
    return [u, v];
  };

  // ---------------- import / open ----------------
  const importImages = async (files: File[], asNewDoc = false) => {
    for (const f of files) {
      if (/\.smgp$/i.test(f.name)) {
        try {
          const d = await importProjectFile(f);
          replaceDocument(d);
          toast(`Opened project “${d.name}”`, 'success');
          scheduleSave();
        } catch (e) {
          toast(cleanError(e), 'error');
        }
        continue;
      }
      try {
        const loaded = await loadFile(f);
        const img = loaded.frames[0];
        if (asNewDoc) {
          const d = newDoc(img.width, img.height, null, f.name.replace(/\.[^.]+$/, ''));
          const layer = imageLayerFrom(d, img, f.name);
          const raster = { ...newRaster(d, f.name), canvas: (layer as Extract<Layer, { kind: 'image' }>).canvas };
          d.layers = [raster, newRaster(d, 'Paint')];
          replaceDocument(d);
          scheduleSave();
          asNewDoc = false; // further files become layers
        } else {
          const d = docRef.current;
          const layer = imageLayerFrom(d, img, f.name);
          commit(insertAbove(d, layer, st.current.selectedId));
          setSelectedId(layer.id);
          setTool('move');
        }
        if (loaded.frames.length > 1) toast(`${f.name}: imported the first of ${loaded.frames.length} frames`);
      } catch (e) {
        toast(`${f.name}: ${cleanError(e)}`, 'error');
      }
    }
  };

  const saveProject = async () => {
    try {
      const blob = await exportProjectFile(docRef.current);
      saveBlob(blob, `${docRef.current.name.replace(/[\\/:*?"<>|]+/g, '-') || 'design'}.smgp`);
      await autosave(docRef.current);
      setSaveState('saved');
      setLastSaved(Date.now());
      toast('Project saved (.smgp)', 'success');
    } catch (e) {
      toast(`Could not save: ${cleanError(e)}`, 'error');
    }
  };

  // ---------------- pointer handling ----------------
  const toDoc = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = viewport.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(e.clientX - r.left - v.panX) / v.zoom, (e.clientY - r.top - v.panY) / v.zoom];
  };

  const handleAt = (l: Layer, sxp: number, syp: number): Handle | null => {
    const v = viewRef.current;
    if (l.kind === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) {
      const p1 = [v.panX + l.x * v.zoom, v.panY + l.y * v.zoom], p2 = [v.panX + (l.x + l.w) * v.zoom, v.panY + (l.y + l.h) * v.zoom];
      if (Math.hypot(sxp - p1[0], syp - p1[1]) < 10) return 'p1';
      if (Math.hypot(sxp - p2[0], syp - p2[1]) < 10) return 'p2';
      return null;
    }
    if (l.kind === 'raster') return null;
    const b = layerBox(l);
    const cx = v.panX + (b.x + b.w / 2) * v.zoom, cy = v.panY + (b.y + b.h / 2) * v.zoom;
    const a = (-l.rotation * Math.PI) / 180;
    const dx = sxp - cx, dy = syp - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    const hw = (b.w * v.zoom) / 2, hh = (b.h * v.zoom) / 2;
    if (Math.hypot(lx, ly + hh + 28) < 10) return 'rot';
    for (const [h, hx, hy] of [['nw', -hw, -hh], ['ne', hw, -hh], ['sw', -hw, hh], ['se', hw, hh]] as const) if (Math.abs(lx - hx) < 9 && Math.abs(ly - hy) < 9) return h;
    return null;
  };

  const snap = (box: Box, dx: number, dy: number, id: string): [number, number] => {
    guides.current = [];
    if (!st.current.grid.snap) return [dx, dy];
    const d = docRef.current;
    const th = 7 / viewRef.current.zoom;
    const xs = [0, d.width / 2, d.width];
    const ys = [0, d.height / 2, d.height];
    for (const l of d.layers) {
      if (l.id === id || !l.visible) continue;
      const b = layerBox(l);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    const best = (cands: number[], edges: number[]) => {
      let bd = th, off = 0, at = NaN;
      for (const e of edges) for (const c of cands) if (Math.abs(c - e) < bd) { bd = Math.abs(c - e); off = c - e; at = c; }
      return { off, at };
    };
    const bx = best(xs, [box.x + dx, box.x + dx + box.w / 2, box.x + dx + box.w]);
    const by = best(ys, [box.y + dy, box.y + dy + box.h / 2, box.y + dy + box.h]);
    let ndx = dx + bx.off, ndy = dy + by.off;
    if (!Number.isNaN(bx.at)) guides.current.push({ v: true, at: bx.at });
    else if (st.current.grid.show) ndx = Math.round((box.x + dx) / st.current.grid.size) * st.current.grid.size - box.x;
    if (!Number.isNaN(by.at)) guides.current.push({ v: false, at: by.at });
    else if (st.current.grid.show) ndy = Math.round((box.y + dy) / st.current.grid.size) * st.current.grid.size - box.y;
    return [ndx, ndy];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = viewport.current!;
    vp.setPointerCapture(e.pointerId);
    const r = vp.getBoundingClientRect();
    pointers.current.set(e.pointerId, [e.clientX - r.left, e.clientY - r.top]);
    if (pointers.current.size === 2) {
      // two-finger pinch / pan
      const [a, b] = [...pointers.current.values()];
      const v = viewRef.current;
      drag.current = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: v.zoom, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, panX: v.panX, panY: v.panY };
      live.current = null;
      return;
    }
    const [px, py] = toDoc(e);
    const d = docRef.current;
    const s = st.current;
    if (e.button === 1 || s.tool === 'hand' || s.spaceDown) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: viewRef.current.panX, py: viewRef.current.panY };
      return;
    }
    if (e.button !== 0) return;
    switch (s.tool) {
      case 'move': {
        const sel = d.layers.find((l) => l.id === s.selectedId);
        if (sel && !sel.locked) {
          const h = handleAt(sel, e.clientX - r.left, e.clientY - r.top);
          if (h) {
            drag.current = { kind: 'handle', base: d, id: sel.id, handle: h, layer: sel };
            return;
          }
        }
        const hit = [...d.layers].reverse().find((l) => !l.locked && hitTest(l, px, py));
        if (!hit) {
          setSelectedId(null);
          return;
        }
        setSelectedId(hit.id);
        drag.current = { kind: 'move', base: d, id: hit.id, sx: px, sy: py, x0: hit.x, y0: hit.y, box: layerBox(hit), moved: false };
        return;
      }
      case 'brush':
      case 'pencil':
      case 'eraser': {
        const target = paintTarget();
        if (!target) return;
        const canvas = makeCanvas(target.canvas.width, target.canvas.height);
        const [u, v] = docToLayerPixel(target, px, py);
        const tip = s.tool === 'pencil' ? null : brushTip(s.opts.size, s.tool === 'eraser' ? '#000000' : s.opts.color, s.tool === 'eraser' ? Math.max(0.5, s.opts.hardness) : s.opts.hardness);
        const ctx = canvas.getContext('2d')!;
        if (tip) stampLine(ctx, tip, u, v, u, v);
        else pixelLine(ctx, s.opts.color, s.opts.size, u, v, u, v);
        live.current = { layerId: target.id, canvas, opacity: s.opts.opacity, erase: s.tool === 'eraser' };
        drag.current = { kind: 'stroke', base: docRef.current, id: target.id, canvas, last: [u, v], tip };
        requestRender();
        return;
      }
      case 'fill': {
        const target = paintTarget();
        if (!target) return;
        const rgba = hexToRgba(s.opts.color, s.opts.opacity);
        const canvas = cloneCanvas(target.canvas);
        let n: number;
        if (s.opts.sampleAll && !target.rotation && !target.flipX && !target.flipY) {
          const comp = compositeData(docRef.current);
          const mask = floodMask(comp.data, comp.width, comp.height, px, py, s.opts.tolerance);
          n = paintMask(canvas, mask, comp.width, comp.height, target.x, target.y, rgba);
        } else {
          const [u, v] = docToLayerPixel(target, px, py);
          n = floodFill(canvas, u, v, rgba, s.opts.tolerance);
        }
        if (n > 0) commit(replaceLayer(docRef.current, target.id, { canvas } as Partial<Layer>));
        return;
      }
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow': {
        const isLine = s.tool === 'line' || s.tool === 'arrow';
        const shape = newShape(s.tool, px, py, 0, 0, {
          fill: isLine ? null : s.opts.shapeFill ? s.opts.color : null,
          stroke: isLine ? s.opts.color : s.opts.shapeStroke || !s.opts.shapeFill ? s.opts.color2 === '#ffffff' && !s.opts.shapeFill ? '#14162b' : s.opts.color2 : null,
          strokeWidth: s.opts.strokeWidth,
          radius: s.tool === 'rect' ? s.opts.radius : 0,
        });
        const base = docRef.current;
        setTransient(insertAbove(base, shape, s.selectedId));
        drag.current = { kind: 'shape', base, id: shape.id, sx: px, sy: py, shape: s.tool };
        return;
      }
      case 'text': {
        const hit = [...d.layers].reverse().find((l) => l.kind === 'text' && hitTest(l, px, py));
        if (hit) {
          setSelectedId(hit.id);
        } else {
          const t = newText('Your text', px, py - s.opts.fontSize * 0.6, { color: s.opts.color, size: s.opts.fontSize, w: Math.max(200, Math.min(d.width - px, s.opts.fontSize * 8)) });
          commit(insertAbove(d, t, s.selectedId));
          setSelectedId(t.id);
        }
        setRightTab('props');
        setPanelsOpen(true);
        setTimeout(() => {
          textRef.current?.focus();
          textRef.current?.select();
        }, 30);
        return;
      }
      case 'eyedropper': {
        const comp = compositeData(d);
        const x = Math.floor(px), y = Math.floor(py);
        if (x < 0 || y < 0 || x >= comp.width || y >= comp.height) return;
        const i = (y * comp.width + x) * 4;
        const hex = rgbToHex(comp.data[i], comp.data[i + 1], comp.data[i + 2]);
        setOpts((o) => (e.altKey || e.shiftKey ? { ...o, color2: hex } : { ...o, color: hex }));
        toast(`Picked ${hex}${e.altKey || e.shiftKey ? ' (secondary)' : ''}`);
        return;
      }
      case 'crop': {
        drag.current = { kind: 'crop', sx: Math.max(0, Math.min(d.width, px)), sy: Math.max(0, Math.min(d.height, py)) };
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = viewport.current!.getBoundingClientRect();
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [e.clientX - r.left, e.clientY - r.top]);
    const [px, py] = toDoc(e);
    hover.current = [px, py];
    setCursor([Math.floor(px), Math.floor(py)]);
    const g = drag.current;
    if (!g) {
      requestRender();
      return;
    }
    const s = st.current;
    switch (g.kind) {
      case 'pinch': {
        const pts = [...pointers.current.values()];
        if (pts.length < 2) return;
        const [a, b] = pts;
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const zoom = Math.min(32, Math.max(0.02, (g.z0 * dist) / g.d0));
        setView({ zoom, panX: mx - ((g.mx - g.panX) * zoom) / g.z0, panY: my - ((g.my - g.panY) * zoom) / g.z0 });
        return;
      }
      case 'pan':
        setView({ ...viewRef.current, panX: g.px + e.clientX - g.sx, panY: g.py + e.clientY - g.sy });
        return;
      case 'move': {
        let dx = px - g.sx, dy = py - g.sy;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        [dx, dy] = snap(g.box, dx, dy, g.id);
        if (Math.abs(dx) + Math.abs(dy) > 0.5) g.moved = true;
        setTransient(replaceLayer(g.base, g.id, { x: g.x0 + dx, y: g.y0 + dy }));
        return;
      }
      case 'handle': {
        const l = g.layer;
        if (g.handle === 'p1' || g.handle === 'p2') {
          if (l.kind !== 'shape') return;
          let ex = px, ey = py;
          const ox = g.handle === 'p1' ? l.x + l.w : l.x, oy = g.handle === 'p1' ? l.y + l.h : l.y;
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(ey - oy, ex - ox) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(ex - ox, ey - oy);
            ex = ox + Math.cos(ang) * len;
            ey = oy + Math.sin(ang) * len;
          }
          setTransient(replaceLayer(g.base, g.id, g.handle === 'p1' ? { x: ex, y: ey, w: ox - ex, h: oy - ey } : { w: ex - l.x, h: ey - l.y }));
          return;
        }
        const b = layerBox(l);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (g.handle === 'rot') {
          let ang = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
          if (e.shiftKey) ang = Math.round(ang / 15) * 15;
          setTransient(replaceLayer(g.base, g.id, { rotation: ((ang % 360) + 360) % 360 }));
          return;
        }
        // Resize in the layer's local (unrotated) frame with the opposite corner fixed.
        const [lx, ly] = toLocal(l, px, py);
        const ax = g.handle.includes('w') ? b.x + b.w : b.x;
        const ay = g.handle.includes('n') ? b.y + b.h : b.y;
        let nw = Math.max(4, Math.abs(lx - ax)), nh = Math.max(4, Math.abs(ly - ay));
        const keepAspect = l.kind === 'image' || l.kind === 'text' ? !e.shiftKey : e.shiftKey;
        if (keepAspect) {
          const k = Math.max(nw / b.w, nh / b.h);
          nw = b.w * k;
          nh = b.h * k;
        }
        const nx = g.handle.includes('w') ? ax - nw : ax;
        const ny = g.handle.includes('n') ? ay - nh : ay;
        // Shift the box so the fixed corner stays put in document space when rotated.
        const a = (l.rotation * Math.PI) / 180;
        const ocx = nx + nw / 2 - cx, ocy = ny + nh / 2 - cy;
        const rcx = cx + ocx * Math.cos(a) - ocy * Math.sin(a), rcy = cy + ocx * Math.sin(a) + ocy * Math.cos(a);
        const fx = rcx - nw / 2, fy = rcy - nh / 2;
        let patch: Partial<Layer>;
        if (l.kind === 'text') {
          const k = nw / b.w;
          patch = { x: fx, y: fy, w: l.w * k, size: Math.max(4, l.size * k) } as Partial<Layer>;
        } else patch = { x: fx, y: fy, w: nw, h: nh } as Partial<Layer>;
        setTransient(replaceLayer(g.base, g.id, patch));
        return;
      }
      case 'stroke': {
        const l = docRef.current.layers.find((x) => x.id === g.id);
        if (!l || l.kind !== 'raster') return;
        const [u, v] = docToLayerPixel(l, px, py);
        const ctx = g.canvas.getContext('2d')!;
        if (g.tip) stampLine(ctx, g.tip, g.last[0], g.last[1], u, v);
        else pixelLine(ctx, s.opts.color, s.opts.size, g.last[0], g.last[1], u, v);
        g.last = [u, v];
        requestRender();
        return;
      }
      case 'shape': {
        let w = px - g.sx, h = py - g.sy;
        if (e.shiftKey) {
          if (g.shape === 'line' || g.shape === 'arrow') {
            const ang = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(w, h);
            w = Math.cos(ang) * len;
            h = Math.sin(ang) * len;
          } else {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m;
            h = Math.sign(h || 1) * m;
          }
        }
        const isLine = g.shape === 'line' || g.shape === 'arrow';
        const patch = isLine ? { w, h } : { x: Math.min(g.sx, g.sx + w), y: Math.min(g.sy, g.sy + h), w: Math.abs(w), h: Math.abs(h) };
        setTransient(replaceLayer({ ...docRef.current }, g.id, patch));
        return;
      }
      case 'crop': {
        const d = docRef.current;
        const x2 = Math.max(0, Math.min(d.width, px)), y2 = Math.max(0, Math.min(d.height, py));
        let w = x2 - g.sx, h = y2 - g.sy;
        if (e.shiftKey) {
          const m = Math.min(Math.abs(w), Math.abs(h));
          w = Math.sign(w) * m;
          h = Math.sign(h) * m;
        }
        cropRef.current = { x: Math.min(g.sx, g.sx + w), y: Math.min(g.sy, g.sy + h), w: Math.abs(w), h: Math.abs(h) };
        requestRender();
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = drag.current;
    drag.current = null;
    guides.current = [];
    if (!g) return;
    switch (g.kind) {
      case 'move':
        if (g.moved) commit(docRef.current, g.base);
        else setTransient(g.base);
        break;
      case 'handle':
        if (docRef.current !== g.base) commit(docRef.current, g.base);
        break;
      case 'stroke': {
        const l = docRef.current.layers.find((x) => x.id === g.id);
        live.current = null;
        if (!l || l.kind !== 'raster') break;
        const canvas = cloneCanvas(l.canvas);
        const ctx = canvas.getContext('2d')!;
        ctx.globalAlpha = st.current.opts.opacity;
        ctx.globalCompositeOperation = st.current.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.drawImage(g.canvas, 0, 0);
        commit(replaceLayer(docRef.current, l.id, { canvas } as Partial<Layer>));
        break;
      }
      case 'shape': {
        const l = docRef.current.layers.find((x) => x.id === g.id);
        const b = l ? layerBox(l) : null;
        if (!l || !b || (Math.abs((l as { w: number }).w) < 3 && Math.abs((l as { h: number }).h) < 3)) {
          setTransient(g.base);
        } else {
          commit(docRef.current, g.base);
          setSelectedId(l.id);
        }
        break;
      }
      case 'crop':
        if (cropRef.current && (cropRef.current.w < 2 || cropRef.current.h < 2)) cropRef.current = { x: 0, y: 0, w: docRef.current.width, h: docRef.current.height };
        setCropState(cropRef.current);
        break;
    }
    requestRender();
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const r = viewport.current!.getBoundingClientRect();
    const v = viewRef.current;
    if (e.ctrlKey || e.metaKey) zoomAt(v.zoom * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    else setView({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY });
  }, [zoomAt, setView]);

  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const applyCrop = useCallback(() => {
    const cr = cropRef.current;
    if (!cr || cr.w < 1 || cr.h < 1) return;
    commit(cropDoc(docRef.current, cr));
    setCrop(null);
    setToolState('move');
    toast(`Cropped to ${Math.round(cr.w)}×${Math.round(cr.h)}`);
  }, [commit, toast]);

  // ---------------- keyboard ----------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (isEditable(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        // Document-level commands still work inside text fields; editing keys stay with the field.
        if (mod && ['s', 'e', 'o', 'n'].includes(k)) {
          e.preventDefault();
          if (k === 's') saveProject();
          else if (k === 'e') setDialog('export');
          else if (k === 'o') openInput.current?.click();
          else if (k === 'n') { refreshRecent(); setDialog('new'); }
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      if (mod) {
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
        else if (k === 's') { e.preventDefault(); saveProject(); }
        else if (k === 'e') { e.preventDefault(); setDialog('export'); }
        else if (k === 'n' && e.shiftKey) { e.preventDefault(); addLayer(); }
        else if (k === 'n') { e.preventDefault(); refreshRecent(); setDialog('new'); }
        else if (k === 'o') { e.preventDefault(); openInput.current?.click(); }
        else if (k === 'd') { e.preventDefault(); duplicateLayer(); }
        else if (k === '=' || k === '+') { e.preventDefault(); zoomAt(viewRef.current.zoom * 1.25); }
        else if (k === '-') { e.preventDefault(); zoomAt(viewRef.current.zoom / 1.25); }
        else if (k === '0') { e.preventDefault(); fit(); }
        else if (k === '1') { e.preventDefault(); zoomAt(1); }
        else if (k === ']' && st.current.selectedId) { e.preventDefault(); moveLayer(st.current.selectedId, 1); }
        else if (k === '[' && st.current.selectedId) { e.preventDefault(); moveLayer(st.current.selectedId, -1); }
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) { setTool(t.id); return; }
      if (k === '[') setOpts((o) => ({ ...o, size: Math.max(1, Math.round(o.size / 1.2)) }));
      else if (k === ']') setOpts((o) => ({ ...o, size: Math.min(500, Math.round(o.size * 1.2) + 1) }));
      else if (k === 'x') setOpts((o) => ({ ...o, color: o.color2, color2: o.color }));
      else if (k === "'") setGrid((g) => ({ ...g, show: !g.show }));
      else if (k === '?') setDialog('shortcuts');
      else if ((k === 'delete' || k === 'backspace') && st.current.selectedId) { e.preventDefault(); deleteLayer(); }
      else if (k === 'enter' && st.current.tool === 'crop') applyCrop();
      else if (k === 'escape') { if (st.current.tool === 'crop') setTool('move'); else setSelectedId(null); }
      else if (k.startsWith('arrow') && st.current.selectedId) {
        e.preventDefault();
        const l = docRef.current.layers.find((x) => x.id === st.current.selectedId);
        if (!l || l.locked) return;
        const n = e.shiftKey ? 10 : 1;
        const dx = k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0;
        const dy = k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0;
        patchLayer(l.id, { x: l.x + dx, y: l.y + dy }, 'nudge');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // paste images
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || /\.(smg|svg)$/i.test(f.name));
      if (files.length) {
        e.preventDefault();
        importImages(files);
      }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  });

  // ---------------- UI ----------------
  const canUndo = undo.current.length > 0, canRedo = redo.current.length > 0;
  const pixelSel = selected && (selected.kind === 'raster' || selected.kind === 'image');
  const cursorStyle = spaceDown || tool === 'hand' ? (drag.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'move' ? 'default' : tool === 'text' ? 'text' : tool === 'brush' || tool === 'eraser' || tool === 'pencil' ? 'none' : 'crosshair';

  const menus: Array<{ label: string; items: Array<{ label: string; key?: string; onClick: () => void; disabled?: boolean } | 'sep'> }> = [
    {
      label: 'File',
      items: [
        { label: 'New design…', key: 'Ctrl+N', onClick: () => { refreshRecent(); setDialog('new'); } },
        { label: 'Open project or image…', key: 'Ctrl+O', onClick: () => openInput.current?.click() },
        { label: 'Import image as layer…', onClick: () => importInput.current?.click() },
        'sep',
        { label: 'Save project (.smgp)', key: 'Ctrl+S', onClick: saveProject },
        { label: 'Duplicate project', onClick: () => { const d = duplicateDoc(docRef.current); replaceDocument(d); scheduleSave(); toast(`Now editing “${d.name}”`); } },
        { label: 'Recent projects…', onClick: () => { refreshRecent(); setDialog('new'); } },
        'sep',
        { label: 'Export image…', key: 'Ctrl+E', onClick: () => setDialog('export') },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', key: 'Ctrl+Z', onClick: doUndo, disabled: !canUndo },
        { label: 'Redo', key: 'Ctrl+Shift+Z', onClick: doRedo, disabled: !canRedo },
        'sep',
        { label: 'New layer', key: 'Ctrl+Shift+N', onClick: addLayer },
        { label: 'Duplicate layer', key: 'Ctrl+D', onClick: duplicateLayer, disabled: !selected },
        { label: 'Delete layer', key: 'Del', onClick: deleteLayer, disabled: !selected },
        { label: 'Rasterize layer', onClick: () => selected && commit(rasterize(docRef.current, selected.id)), disabled: !selected || selected.kind === 'raster' },
        { label: 'Merge down', onClick: () => selected && commit(mergeDown(docRef.current, selected.id)), disabled: !selected || doc.layers.indexOf(selected) <= 0 },
      ],
    },
    {
      label: 'Image',
      items: [
        { label: 'Resize image…', onClick: () => setDialog('resize') },
        { label: 'Canvas size…', onClick: () => setDialog('canvas') },
        { label: 'Crop', key: 'C', onClick: () => setTool('crop') },
        'sep',
        { label: 'Rotate 90° clockwise', onClick: () => commit(rotateDoc(docRef.current, 1)) },
        { label: 'Rotate 90° counter-clockwise', onClick: () => commit(rotateDoc(docRef.current, 3)) },
        { label: 'Rotate 180°', onClick: () => commit(rotateDoc(docRef.current, 2)) },
        { label: 'Flip horizontal', onClick: () => commit(flipDoc(docRef.current, true)) },
        { label: 'Flip vertical', onClick: () => commit(flipDoc(docRef.current, false)) },
        'sep',
        { label: doc.background ? 'Make background transparent' : 'Use white background', onClick: () => commit({ ...docRef.current, background: docRef.current.background ? null : '#ffffff', updatedAt: Date.now() }) },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom in', key: 'Ctrl+=', onClick: () => zoomAt(viewRef.current.zoom * 1.25) },
        { label: 'Zoom out', key: 'Ctrl+-', onClick: () => zoomAt(viewRef.current.zoom / 1.25) },
        { label: 'Fit to screen', key: 'Ctrl+0', onClick: fit },
        { label: 'Actual pixels (100%)', key: 'Ctrl+1', onClick: () => zoomAt(1) },
        'sep',
        { label: `${grid.show ? 'Hide' : 'Show'} grid`, key: "'", onClick: () => setGrid((g) => ({ ...g, show: !g.show })) },
        { label: `${grid.snap ? 'Disable' : 'Enable'} snapping`, onClick: () => setGrid((g) => ({ ...g, snap: !g.snap })) },
        { label: 'Keyboard shortcuts', key: '?', onClick: () => setDialog('shortcuts') },
      ],
    },
  ];

  return (
    <div className="studio" data-testid="studio">
      <div className="studio-top">
        <Link to="/" className="brand sm" aria-label="SMG home"><LogoMark size={24} /></Link>
        {menus.map((m) => <Menu key={m.label} label={m.label} items={m.items} />)}
        <input
          className="doc-name"
          value={doc.name}
          aria-label="Document name"
          onChange={(e) => { const d = { ...docRef.current, name: e.target.value }; docRef.current = d; setDocState(d); scheduleSave(); }}
        />
        <span className="save-state" data-save={saveState} title={lastSaved ? `Saved in this browser at ${new Date(lastSaved).toLocaleTimeString()}` : 'Autosaves to this browser'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'saved' ? 'Saved locally' : saveState === 'error' ? 'Autosave failed' : 'Autosave on'}
        </span>
        <span className="spacer" />
        <button className="btn icon sm ghost" onClick={doUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={16} /></button>
        <button className="btn icon sm ghost" onClick={doRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" size={16} /></button>
        <button className={`btn icon sm${panelsOpen ? ' active' : ' ghost'}`} onClick={() => setPanelsOpen((p) => !p)} title="Toggle panels" aria-label="Toggle panels" aria-pressed={panelsOpen}><Icon name="sliders" size={15} /></button>
        <button className="btn sm" onClick={saveProject} title="Save project (Ctrl+S)" aria-label="Save project"><Icon name="save" size={15} /><span className="hide-sm">Save</span></button>
        <button className="btn sm primary" onClick={() => setDialog('export')} data-testid="open-export" aria-label="Export"><Icon name="download" size={15} /><span className="hide-xs">Export</span></button>
      </div>

      <ToolOptionsBar tool={tool} opts={opts} setOpts={setOpts} crop={crop} onApplyCrop={applyCrop} onCancelCrop={() => setTool('move')} grid={grid} setGrid={setGrid} />

      <div className="studio-body">
        <div className="toolbar" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`tool${tool === t.id ? ' on' : ''}`} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={tool === t.id} data-tool={t.id}>
              <Icon name={t.icon} size={18} />
            </button>
          ))}
          <div className="color-pair">
            <input type="color" className="c1" value={toHex(opts.color)} onChange={(e) => setOpts((o) => ({ ...o, color: e.target.value }))} aria-label="Primary colour" title="Primary colour" />
            <input type="color" className="c2" value={toHex(opts.color2)} onChange={(e) => setOpts((o) => ({ ...o, color2: e.target.value }))} aria-label="Secondary colour" title="Secondary colour" />
            <button className="swap" onClick={() => setOpts((o) => ({ ...o, color: o.color2, color2: o.color }))} title="Swap colours (X)" aria-label="Swap colours">⇄</button>
          </div>
        </div>

        <div
          ref={viewport}
          className="viewport"
          style={{ cursor: cursorStyle }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { hover.current = null; setCursor(null); requestRender(); }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); importImages([...e.dataTransfer.files]); }}
          data-testid="viewport"
        >
          <div className="stage" style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`, width: doc.width, height: doc.height }}>
            <div className="stage-bg checker" style={{ width: doc.width, height: doc.height, backgroundSize: `${16 / view.zoom}px ${16 / view.zoom}px` }} />
            <canvas ref={docCanvas} className="doc-canvas" style={{ imageRendering: view.zoom >= 2 ? 'pixelated' : 'auto' }} data-testid="doc-canvas" />
          </div>
          <canvas ref={overlay} className="overlay" />
        </div>

        {panelsOpen && (
          <aside className="panels">
            <button className="btn sm ghost panels-close" onClick={() => setPanelsOpen(false)}><Icon name="x" size={14} /> Close panels</button>
            <div className="panel">
              <div className="panel-tabs">
                <button className={rightTab === 'props' ? 'on' : ''} onClick={() => setRightTab('props')}>Properties</button>
                <button className={rightTab === 'adjust' ? 'on' : ''} onClick={() => setRightTab('adjust')} data-testid="tab-adjust">Adjust &amp; filters</button>
              </div>
              {rightTab === 'props' ? (
                selected ? (
                  <PropertiesPanel
                    doc={doc}
                    layer={selected}
                    textRef={textRef}
                    onPatch={(p, key) => patchLayer(selected.id, p, key)}
                    onAlign={(a) => patchLayer(selected.id, alignLayer(docRef.current, selected, a), `align-${a}`)}
                    onRasterize={() => commit(rasterize(docRef.current, selected.id))}
                    onFlip={(h) => patchLayer(selected.id, h ? { flipX: !selected.flipX } : { flipY: !selected.flipY }, `flip${h}`)}
                    onRotate={(deg) => patchLayer(selected.id, { rotation: (selected.rotation + deg) % 360 }, `rot90-${Date.now()}`)}
                  />
                ) : (
                  <div className="muted" style={{ fontSize: 13 }}>
                    Select a layer with the move tool (V) to edit its position, size and style. Canvas: {doc.width}×{doc.height}px, {doc.background ? `background ${doc.background}` : 'transparent background'}.
                  </div>
                )
              ) : (
                <AdjustPanel state={adjust} onChange={setAdjust} onApply={applyAdjust} onReset={() => { setAdjust(NO_ADJUST_STATE); setAdjPreview(null); }} enabled={!!pixelSel} busy={adjBusy} />
              )}
            </div>
            <LayersPanel
              doc={doc}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onToggle={(id) => { const l = docRef.current.layers.find((x) => x.id === id)!; commit(replaceLayer(docRef.current, id, { visible: !l.visible })); }}
              onLock={(id) => { const l = docRef.current.layers.find((x) => x.id === id)!; commit(replaceLayer(docRef.current, id, { locked: !l.locked })); }}
              onRename={(id, name) => commit(replaceLayer(docRef.current, id, { name }))}
              onMove={moveLayer}
              onReorder={reorder}
              onAdd={addLayer}
              onDuplicate={duplicateLayer}
              onDelete={deleteLayer}
              onMergeDown={() => selected && commit(mergeDown(docRef.current, selected.id))}
              onOpacity={(v, final) => selected && (final ? patchLayer(selected.id, { opacity: v }, 'opacity') : setTransient(replaceLayer(docRef.current, selected.id, { opacity: v })))}
              onBlend={(b) => selected && commit(replaceLayer(docRef.current, selected.id, { blend: b }))}
            />
          </aside>
        )}
      </div>

      <div className="studio-status">
        <span>{doc.width}×{doc.height}px</span>
        <span>{doc.layers.length} layer{doc.layers.length === 1 ? '' : 's'}</span>
        {cursor && <span className="mono">x {cursor[0]} · y {cursor[1]}</span>}
        <span className="spacer" />
        <button className="btn icon sm ghost" onClick={() => zoomAt(viewRef.current.zoom / 1.25)} aria-label="Zoom out"><Icon name="zoomOut" size={15} /></button>
        <button className="zoom-label mono" onClick={() => zoomAt(1)} title="Actual pixels">{Math.round(view.zoom * 100)}%</button>
        <button className="btn icon sm ghost" onClick={() => zoomAt(viewRef.current.zoom * 1.25)} aria-label="Zoom in"><Icon name="zoomIn" size={15} /></button>
        <button className="btn icon sm ghost" onClick={fit} aria-label="Fit to screen" title="Fit (Ctrl+0)"><Icon name="fit" size={15} /></button>
        <button className="btn sm ghost" onClick={() => setDialog('shortcuts')}>Shortcuts <kbd>?</kbd></button>
      </div>

      <input ref={openInput} type="file" hidden accept=".smgp,image/*,.smg,.svg" data-testid="open-input" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) importImages(f, true); setDialog(null); }} />
      <input ref={importInput} type="file" hidden multiple accept="image/*,.smg,.svg" data-testid="import-input" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) importImages(f); }} />

      <NewDocDialog
        open={dialog === 'new'}
        onClose={() => setDialog(null)}
        recent={recent}
        onOpenFile={() => openInput.current?.click()}
        onCreate={(w, h, bg, name) => { const d = newDoc(w, h, bg, name); replaceDocument(d); scheduleSave(); setDialog(null); setTool('brush'); }}
        onTemplate={(id) => { const t = TEMPLATES.find((x) => x.id === id)!; const d = t.build(); replaceDocument(d); scheduleSave(); setDialog(null); setTool('move'); }}
        onOpenRecent={async (id) => { try { const d = await loadProject(id); if (d) { replaceDocument(d); await setPref('studio.current', d.id); setDialog(null); } } catch (e) { toast(cleanError(e), 'error'); } }}
        onDeleteRecent={async (id) => { await deleteProject(id); refreshRecent(); }}
      />
      <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} doc={doc} />
      <ResizeDialog open={dialog === 'resize'} onClose={() => setDialog(null)} doc={doc} mode="image" onApply={(w, h) => commit(resizeDoc(docRef.current, w, h))} />
      <ResizeDialog open={dialog === 'canvas'} onClose={() => setDialog(null)} doc={doc} mode="canvas" onApply={(w, h, a) => commit(canvasSizeDoc(docRef.current, w, h, a))} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={() => setDialog(null)} />

      {recovery && (
        <div className="recover-card fade-in" role="alertdialog" aria-label="Recover unsaved work">
          <img src={recovery.thumb} alt="" className="checker" />
          <div>
            <div style={{ fontWeight: 600 }}>Continue where you left off?</div>
            <div className="muted" style={{ fontSize: 13 }}>“{recovery.name}” · {recovery.width}×{recovery.height} · autosaved {new Date(recovery.updatedAt).toLocaleString()}</div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn primary sm" data-testid="recover" onClick={async () => { try { const d = await loadProject(recovery.id); if (d) replaceDocument(d); } catch (e) { toast(cleanError(e), 'error'); } setRecovery(null); }}>Restore</button>
              <button className="btn sm" onClick={() => setRecovery(null)}>Start fresh</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- tool options bar ---------------- */
function ToolOptionsBar({ tool, opts, setOpts, crop, onApplyCrop, onCancelCrop, grid, setGrid }: {
  tool: ToolId;
  opts: ToolOpts;
  setOpts: React.Dispatch<React.SetStateAction<ToolOpts>>;
  crop: Box | null;
  onApplyCrop: () => void;
  onCancelCrop: () => void;
  grid: { show: boolean; size: number; snap: boolean };
  setGrid: React.Dispatch<React.SetStateAction<{ show: boolean; size: number; snap: boolean }>>;
}) {
  const set = (p: Partial<ToolOpts>) => setOpts((o) => ({ ...o, ...p }));
  let content: ReactNode = null;
  const label = TOOLS.find((t) => t.id === tool)!.label;
  if (tool === 'brush' || tool === 'eraser' || tool === 'pencil') {
    content = (
      <>
        <div className="opt"><Range label="Size" value={opts.size} min={1} max={300} onChange={(size) => set({ size })} format={(v) => `${v}px`} /></div>
        {tool !== 'pencil' && <div className="opt"><Range label="Hardness" value={Math.round(opts.hardness * 100)} min={0} max={100} onChange={(v) => set({ hardness: v / 100 })} format={(v) => `${v}%`} /></div>}
        <div className="opt"><Range label="Opacity" value={Math.round(opts.opacity * 100)} min={1} max={100} onChange={(v) => set({ opacity: v / 100 })} format={(v) => `${v}%`} /></div>
      </>
    );
  } else if (tool === 'fill') {
    content = (
      <>
        <div className="opt"><Range label="Tolerance" value={opts.tolerance} min={0} max={255} onChange={(tolerance) => set({ tolerance })} /></div>
        <div className="opt"><Range label="Opacity" value={Math.round(opts.opacity * 100)} min={1} max={100} onChange={(v) => set({ opacity: v / 100 })} format={(v) => `${v}%`} /></div>
        <label className="check"><input type="checkbox" checked={opts.sampleAll} onChange={(e) => set({ sampleAll: e.target.checked })} /> Sample all layers</label>
      </>
    );
  } else if (tool === 'rect' || tool === 'ellipse') {
    content = (
      <>
        <label className="check"><input type="checkbox" checked={opts.shapeFill} onChange={(e) => set({ shapeFill: e.target.checked })} /> Fill (primary)</label>
        <label className="check"><input type="checkbox" checked={opts.shapeStroke} onChange={(e) => set({ shapeStroke: e.target.checked })} /> Outline (secondary)</label>
        <div className="opt"><Range label="Outline" value={opts.strokeWidth} min={1} max={80} onChange={(strokeWidth) => set({ strokeWidth })} format={(v) => `${v}px`} /></div>
        {tool === 'rect' && <div className="opt"><Range label="Corners" value={opts.radius} min={0} max={200} onChange={(radius) => set({ radius })} format={(v) => `${v}px`} /></div>}
        <span className="muted hint">Shift = square/circle</span>
      </>
    );
  } else if (tool === 'line' || tool === 'arrow') {
    content = (
      <>
        <div className="opt"><Range label="Width" value={opts.strokeWidth} min={1} max={80} onChange={(strokeWidth) => set({ strokeWidth })} format={(v) => `${v}px`} /></div>
        <span className="muted hint">Shift = 45° steps</span>
      </>
    );
  } else if (tool === 'text') {
    content = (
      <>
        <div className="opt"><Range label="Default size" value={opts.fontSize} min={8} max={300} onChange={(fontSize) => set({ fontSize })} format={(v) => `${v}px`} /></div>
        <span className="muted hint">Click the canvas to add text; edit it in Properties.</span>
      </>
    );
  } else if (tool === 'crop') {
    content = (
      <>
        <span className="mono">{crop ? `${Math.round(crop.w)} × ${Math.round(crop.h)} at ${Math.round(crop.x)}, ${Math.round(crop.y)}` : 'Drag to select'}</span>
        <button className="btn sm primary" onClick={onApplyCrop} disabled={!crop} data-testid="apply-crop"><Icon name="check" size={14} /> Apply crop</button>
        <button className="btn sm" onClick={onCancelCrop}>Cancel</button>
        <span className="muted hint">Shift = square · Enter / Esc</span>
      </>
    );
  } else if (tool === 'move') {
    content = (
      <>
        <label className="check"><input type="checkbox" checked={grid.snap} onChange={(e) => setGrid((g) => ({ ...g, snap: e.target.checked }))} /> Snapping</label>
        <label className="check"><input type="checkbox" checked={grid.show} onChange={(e) => setGrid((g) => ({ ...g, show: e.target.checked }))} /> Grid</label>
        {grid.show && (
          <Segmented value={String(grid.size)} ariaLabel="Grid size" onChange={(v) => setGrid((g) => ({ ...g, size: Number(v) }))} options={['8', '16', '32', '64'].map((v) => ({ value: v, label: v }))} />
        )}
        <span className="muted hint">Drag handles to resize (Shift = free), top handle rotates</span>
      </>
    );
  } else if (tool === 'eyedropper') {
    content = <span className="muted hint">Click to pick the primary colour; Shift/Alt+click for the secondary.</span>;
  } else {
    content = <span className="muted hint">Drag to pan · Ctrl+wheel to zoom · hold Space with any tool</span>;
  }
  return (
    <div className="tool-options">
      <span className="tool-name">{label}</span>
      {content}
    </div>
  );
}

/* ---------------- dropdown menu ---------------- */
function Menu({ label, items }: { label: string; items: Array<{ label: string; key?: string; onClick: () => void; disabled?: boolean } | 'sep'> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`menu-btn-top${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>{label}</button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button key={it.label} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}>
                <span>{it.label}</span>
                {it.key && <kbd>{it.key}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

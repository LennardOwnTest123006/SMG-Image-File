/** Small shared UI primitives. */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

/* ---------- Logo ---------- */
export function LogoMark({ size = 32 }: { size?: number }) {
  const cells: Array<[number, number, number, number]> = [];
  const centers = [19, 32, 45];
  const op = [1, 0.92, 0.8, 0.64, 0.48];
  centers.forEach((cy, j) => centers.forEach((cx, i) => cells.push([cx, cy, 12 - 2 * (i + j), op[i + j]])));
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="SMG logo">
      <defs>
        <linearGradient id="lm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3D7BFF" />
          <stop offset=".55" stopColor="#6A5CFF" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
        <radialGradient id="lm-h" cx=".25" cy=".15" r=".9">
          <stop offset="0" stopColor="#fff" stopOpacity=".35" />
          <stop offset=".6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#lm-g)" />
      <rect width="64" height="64" rx="16" fill="url(#lm-h)" />
      {cells.map(([cx, cy, s, o], k) => (
        <rect key={k} x={cx - s / 2} y={cy - s / 2} width={s} height={s} rx={Math.min(3, s / 2.6)} fill="#fff" fillOpacity={o} />
      ))}
    </svg>
  );
}

/* ---------- Toasts ---------- */
type Toast = { id: number; kind: 'info' | 'success' | 'error'; text: string };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------- Range with filled track ---------- */
export function Range({ value, min, max, step = 1, onChange, label, format, disabled, id: idProp }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label?: ReactNode; format?: (v: number) => ReactNode; disabled?: boolean; id?: string }) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      {label !== undefined && (
        <label htmlFor={id}>
          <span id={`${id}-l`}>{label}</span>
          <span className="mono" style={{ color: 'var(--text)' }}>{format ? format(value) : value}</span>
        </label>
      )}
       <input id={id} aria-labelledby={label !== undefined ? `${id}-l` : undefined} type="range" min={min} max={max} step={step} value={value} disabled={disabled} style={{ ['--fill' as string]: `${fill}%` }} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/* ---------- Segmented control ---------- */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Dropzone ---------- */
export function Dropzone({ onFiles, accept, multiple = true, compact, children }: { onFiles: (files: File[]) => void; accept?: string; multiple?: boolean; compact?: boolean; children?: ReactNode }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [onFiles]);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
    >
      <input
        ref={input}
        type="file"
        hidden
        multiple={multiple}
        accept={accept}
        data-testid="file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      {children ?? (
        <>
          <div className="dz-icon">
            <Icon name="upload" size={26} />
          </div>
          <div style={{ fontWeight: 600, fontSize: 17 }}>Drop images here, paste, or click to browse</div>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>
            SMG · PNG · JPEG · WebP · AVIF · GIF · BMP · SVG — processed locally, never uploaded
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Progress ---------- */
export function Progress({ value, indeterminate }: { value?: number; indeterminate?: boolean }) {
  return (
    <div className={`progress${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-valuenow={value !== undefined ? Math.round(value * 100) : undefined} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(2, Math.min(100, (value ?? 0) * 100))}%` }} />
    </div>
  );
}

/* ---------- useObjectUrl ---------- */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

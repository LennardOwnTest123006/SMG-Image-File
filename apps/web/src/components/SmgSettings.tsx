/** SMG encoder settings panel shared by the compressor, converter and studio export. */
import type { SmgMode, SmgPreset } from '@smg/codec';
import { PRESETS } from '@smg/codec';
import { Range, Segmented } from './ui.tsx';

export interface SmgSettingsValue {
  preset: SmgPreset;
  mode: SmgMode;
  quality: number;
  effort: number;
  targetKB: number | null;
  maxColors: number;
  dither: boolean;
  stripMetadata: boolean;
  exactTransparent: boolean;
}

export const DEFAULT_SETTINGS: SmgSettingsValue = {
  preset: 'auto',
  mode: 'auto',
  quality: 80,
  effort: 5,
  targetKB: null,
  maxColors: 256,
  dither: false,
  stripMetadata: false,
  exactTransparent: true,
};

export function applyPreset(s: SmgSettingsValue, preset: SmgPreset): SmgSettingsValue {
  const p = PRESETS[preset];
  return { ...s, preset, mode: p.mode, quality: p.quality, effort: p.effort, maxColors: p.maxColors ?? s.maxColors, dither: p.dither ?? false };
}

/** Convert UI settings to codec EncodeOptions (minus callbacks). */
export function toEncodeOptions(s: SmgSettingsValue) {
  return {
    mode: s.mode,
    quality: s.quality,
    effort: s.effort,
    targetSize: s.targetKB ? Math.round(s.targetKB * 1000) : undefined,
    maxColors: s.maxColors,
    dither: s.dither,
    stripMetadata: s.stripMetadata,
    exactTransparent: s.exactTransparent,
  };
}

export function describeSettings(s: SmgSettingsValue): string {
  const parts = [PRESETS[s.preset].label, s.mode];
  if (s.mode === 'lossy' || s.mode === 'auto') parts.push(`q${s.quality}`);
  if (s.targetKB) parts.push(`≤ ${s.targetKB} KB`);
  return parts.join(' · ');
}

const MODES: Array<{ value: SmgMode; label: string; title: string }> = [
  { value: 'auto', label: 'Auto', title: 'Smallest codec that meets the quality target' },
  { value: 'lossless', label: 'Lossless', title: 'Bit-exact pixels' },
  { value: 'lossy', label: 'Lossy', title: 'Wavelet coding' },
  { value: 'palette', label: 'Palette', title: '≤ 256 colours' },
];

export function SmgSettings({ value, onChange, compact }: { value: SmgSettingsValue; onChange: (v: SmgSettingsValue) => void; compact?: boolean }) {
  const set = (patch: Partial<SmgSettingsValue>) => onChange({ ...value, ...patch });
  const lossyish = value.mode === 'lossy' || value.mode === 'auto';
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="field">
        <label htmlFor="smg-preset">Preset</label>
        <select id="smg-preset" className="input" value={value.preset} onChange={(e) => onChange(applyPreset(value, e.target.value as SmgPreset))}>
          {(Object.keys(PRESETS) as SmgPreset[]).map((k) => (
            <option key={k} value={k}>
              {PRESETS[k].label} — {PRESETS[k].description}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span className="label">Mode</span>
        <Segmented value={value.mode} onChange={(mode) => set({ mode })} options={MODES} ariaLabel="Compression mode" />
      </div>
      {lossyish && (
        <Range id="smg-quality" label="Quality" value={value.quality} min={1} max={100} onChange={(quality) => set({ quality })} disabled={!!value.targetKB} format={(v) => (value.targetKB ? 'auto' : v)} />
      )}
      {value.mode === 'palette' && (
        <>
          <Range id="smg-colors" label="Max colours" value={value.maxColors} min={2} max={256} onChange={(maxColors) => set({ maxColors })} />
          <label className="check">
            <input type="checkbox" checked={value.dither} onChange={(e) => set({ dither: e.target.checked })} /> Dithering (smoother gradients)
          </label>
        </>
      )}
      {!compact && <Range id="smg-effort" label="Effort" value={value.effort} min={1} max={9} onChange={(effort) => set({ effort })} format={(v) => `${v} · ${v <= 3 ? 'fast' : v <= 6 ? 'balanced' : 'thorough'}`} />}
      {(lossyish || value.mode === 'palette') && (
        <div className="field">
          <label htmlFor="smg-target">
            <span>Target size</span>
            <span className="dim">optional</span>
          </label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="smg-target"
              className="input"
              type="number"
              min={0.1}
              step={1}
              placeholder="e.g. 100"
              value={value.targetKB ?? ''}
              onChange={(e) => set({ targetKB: e.target.value === '' ? null : Math.max(0.1, Number(e.target.value)) })}
              style={{ flex: 1 }}
            />
            <span className="muted">KB</span>
          </div>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={value.stripMetadata} onChange={(e) => set({ stripMetadata: e.target.checked })} /> Remove metadata (EXIF, ICC, text)
      </label>
      {!compact && (
        <label className="check" title="When unchecked, colours hidden under fully transparent pixels may be normalised. The result looks identical but is not bit-exact.">
          <input type="checkbox" checked={value.exactTransparent} onChange={(e) => set({ exactTransparent: e.target.checked })} /> Keep hidden colours under transparency (bit-exact)
        </label>
      )}
    </div>
  );
}

/** Canvas size presets and editable design templates for SMG Studio. */
import { FONTS, newDoc, newRaster, newShape, newText, type Doc, type Layer } from './model.ts';

export interface SizePreset {
  id: string;
  label: string;
  group: string;
  width: number;
  height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'ig-post', label: 'Instagram post', group: 'Social', width: 1080, height: 1080 },
  { id: 'ig-portrait', label: 'Instagram portrait', group: 'Social', width: 1080, height: 1350 },
  { id: 'story', label: 'Story / Reel', group: 'Social', width: 1080, height: 1920 },
  { id: 'yt-thumb', label: 'YouTube thumbnail', group: 'Social', width: 1280, height: 720 },
  { id: 'x-header', label: 'X / Twitter header', group: 'Social', width: 1500, height: 500 },
  { id: 'x-post', label: 'X / Twitter post', group: 'Social', width: 1600, height: 900 },
  { id: 'fb-cover', label: 'Facebook cover', group: 'Social', width: 851, height: 315 },
  { id: 'li-banner', label: 'LinkedIn banner', group: 'Social', width: 1584, height: 396 },
  { id: 'og', label: 'Open Graph image', group: 'Web', width: 1200, height: 630 },
  { id: 'banner', label: 'Web banner', group: 'Web', width: 1920, height: 480 },
  { id: 'hd', label: 'Full HD', group: 'Web', width: 1920, height: 1080 },
  { id: 'logo', label: 'Logo', group: 'Brand', width: 1024, height: 1024 },
  { id: 'app-icon', label: 'App icon', group: 'Brand', width: 1024, height: 1024 },
  { id: 'favicon', label: 'Favicon', group: 'Brand', width: 64, height: 64 },
  { id: 'icon', label: 'Icon', group: 'Brand', width: 256, height: 256 },
  { id: 'poster-a4', label: 'Poster A4 (150 dpi)', group: 'Print', width: 1240, height: 1754 },
  { id: 'poster-a3', label: 'Poster A3 (150 dpi)', group: 'Print', width: 1754, height: 2480 },
  { id: 'postcard', label: 'Postcard (150 dpi)', group: 'Print', width: 875, height: 583 },
];

export interface Template {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  build: () => Doc;
}

const DISPLAY = FONTS[1].value;
const SANS = FONTS[0].value;

function doc(name: string, w: number, h: number, bg: string | null, layers: Layer[]): Doc {
  const d = newDoc(w, h, bg, name);
  d.layers = [...layers, newRaster(d, 'Paint')];
  return d;
}

export const TEMPLATES: Template[] = [
  {
    id: 'yt-bold',
    label: 'YouTube thumbnail — bold',
    description: 'Gradient backdrop, huge headline, accent badge',
    width: 1280,
    height: 720,
    build: () =>
      doc('Thumbnail', 1280, 720, '#0b1020', [
        { ...newShape('rect', 0, 0, 1280, 720, { fill: { from: '#3d7bff', to: '#a855f7', angle: 35 } }), name: 'Backdrop' },
        { ...newShape('ellipse', 820, -160, 640, 640, { fill: 'rgba(255,255,255,0.12)' }), name: 'Glow' },
        { ...newShape('rect', 72, 92, 250, 64, { fill: '#fbbf24', radius: 32 }), name: 'Badge' },
        newText('NEW VIDEO', 72, 104, { font: SANS, size: 34, weight: 800, color: '#1f1300', w: 250, align: 'center', letterSpacing: 2 }),
        newText('10× SMALLER\nIMAGES', 72, 200, { font: DISPLAY, size: 132, weight: 800, color: '#ffffff', w: 1100, lineHeight: 1.0, shadow: true }),
        newText('Here’s how the SMG format does it →', 76, 520, { font: SANS, size: 44, weight: 600, color: '#e0e7ff', w: 1100 }),
      ]),
  },
  {
    id: 'poster-event',
    label: 'Event poster',
    description: 'Portrait poster with date and venue',
    width: 1080,
    height: 1350,
    build: () =>
      doc('Event poster', 1080, 1350, '#fff7ed', [
        { ...newShape('ellipse', 540, -220, 900, 900, { fill: '#fb923c' }), name: 'Sun' },
        { ...newShape('ellipse', -260, 760, 760, 760, { fill: '#f43f5e' }), name: 'Circle' },
        { ...newShape('rect', 80, 80, 260, 56, { fill: '#1c1917', radius: 28 }), name: 'Tag' },
        newText('LIVE · 2026', 80, 92, { font: SANS, size: 28, weight: 700, color: '#fff7ed', w: 260, align: 'center', letterSpacing: 3 }),
        newText('Design\nWeekend', 80, 520, { font: DISPLAY, size: 168, weight: 800, color: '#1c1917', w: 920, lineHeight: 0.95 }),
        newText('SAT 14 NOV — 10:00\nThe Old Print Works, Berlin', 80, 1130, { font: SANS, size: 40, weight: 600, color: '#44403c', w: 920, lineHeight: 1.3 }),
      ]),
  },
  {
    id: 'logo-badge',
    label: 'Logo badge',
    description: 'Circular emblem with initials',
    width: 1024,
    height: 1024,
    build: () =>
      doc('Logo', 1024, 1024, null, [
        { ...newShape('ellipse', 112, 112, 800, 800, { fill: { from: '#0ea5e9', to: '#6366f1', angle: 45 } }), name: 'Disc' },
        { ...newShape('ellipse', 172, 172, 680, 680, { fill: null, stroke: 'rgba(255,255,255,0.7)', strokeWidth: 10 }), name: 'Ring' },
        newText('AK', 112, 330, { font: DISPLAY, size: 300, weight: 800, color: '#ffffff', w: 800, align: 'center', lineHeight: 1 }),
        newText('STUDIO', 112, 700, { font: SANS, size: 54, weight: 700, color: '#e0f2fe', w: 800, align: 'center', letterSpacing: 18 }),
      ]),
  },
  {
    id: 'quote',
    label: 'Quote card',
    description: 'Square social post for a quotation',
    width: 1080,
    height: 1080,
    build: () =>
      doc('Quote', 1080, 1080, '#111827', [
        { ...newShape('rect', 60, 60, 960, 960, { fill: null, stroke: '#374151', strokeWidth: 4, radius: 40 }), name: 'Frame' },
        newText('“', 110, 90, { font: 'Georgia, serif', size: 260, weight: 700, color: '#a78bfa', w: 300 }),
        newText('Simplicity is\nthe ultimate\nsophistication.', 130, 380, { font: DISPLAY, size: 92, weight: 700, color: '#f9fafb', w: 820, lineHeight: 1.12 }),
        newText('— Leonardo da Vinci', 134, 860, { font: SANS, size: 38, weight: 500, color: '#9ca3af', w: 820 }),
      ]),
  },
  {
    id: 'sale-banner',
    label: 'Sale banner',
    description: 'Wide promotional web banner',
    width: 1500,
    height: 500,
    build: () =>
      doc('Sale banner', 1500, 500, '#fef08a', [
        { ...newShape('rect', 900, -40, 700, 580, { fill: '#18181b', rotation: 0 }), name: 'Panel', rotation: 12 },
        newText('SUMMER\nSALE', 80, 80, { font: DISPLAY, size: 150, weight: 800, color: '#18181b', w: 800, lineHeight: 0.95 }),
        newText('Up to 50% off everything', 84, 390, { font: SANS, size: 44, weight: 600, color: '#3f3f46', w: 800 }),
        newText('SHOP\nNOW →', 1060, 150, { font: DISPLAY, size: 96, weight: 800, color: '#fef08a', w: 400, lineHeight: 1 }),
      ]),
  },
  {
    id: 'app-icon',
    label: 'App icon',
    description: 'Rounded gradient tile with glyph',
    width: 1024,
    height: 1024,
    build: () =>
      doc('App icon', 1024, 1024, null, [
        { ...newShape('rect', 64, 64, 896, 896, { fill: { from: '#22d3ee', to: '#8b5cf6', angle: 60 }, radius: 200 }), name: 'Tile' },
        { ...newShape('ellipse', 312, 312, 400, 400, { fill: 'rgba(255,255,255,0.95)' }), name: 'Glyph' },
        { ...newShape('ellipse', 412, 412, 200, 200, { fill: '#7c3aed' }), name: 'Pupil' },
      ]),
  },
  {
    id: 'og-card',
    label: 'Blog / Open Graph card',
    description: '1200×630 article share image',
    width: 1200,
    height: 630,
    build: () =>
      doc('Article card', 1200, 630, '#0f172a', [
        { ...newShape('rect', 0, 560, 1200, 70, { fill: { from: '#3d7bff', to: '#a855f7', angle: 0 } }), name: 'Bar' },
        newText('ENGINEERING BLOG', 80, 90, { font: SANS, size: 30, weight: 700, color: '#818cf8', w: 1040, letterSpacing: 4 }),
        newText('How we cut our image\nbandwidth in half', 80, 160, { font: DISPLAY, size: 84, weight: 700, color: '#f8fafc', w: 1040, lineHeight: 1.1 }),
        newText('8 min read · smg.dev', 80, 450, { font: SANS, size: 32, weight: 500, color: '#94a3b8', w: 1040 }),
      ]),
  },
];

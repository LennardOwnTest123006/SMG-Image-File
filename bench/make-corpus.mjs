#!/usr/bin/env node
/**
 * Builds the SMG benchmark corpus in bench/corpus/.
 *
 *   photo-*        real photographs (public domain / CC0, see bench/sources/LICENSES.md)
 *   screenshot-*   UI screenshots rendered from bench/screens/*.html with Chromium
 *   logo-*, icon-* vector artwork with transparency, rasterised with librsvg (sharp)
 *   illustration-* flat vector illustration
 *   gradient-*     smooth synthetic gradients
 *
 * Requirements: `npm install` (sharp, playwright). Chromium is located via
 * PLAYWRIGHT_BROWSERS_PATH or the CHROMIUM_PATH environment variable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'corpus');
fs.mkdirSync(out, { recursive: true });
const manifest = [];

function add(name, category, source, license) {
  manifest.push({ file: `${name}.png`, category, source, license });
}

async function svgToPng(name, svg, category, width) {
  await sharp(Buffer.from(svg), { density: 72 }).resize({ width }).png().toFile(path.join(out, `${name}.png`));
  add(name, category, 'Generated vector artwork (bench/make-corpus.mjs)', 'MIT (part of SMG)');
}

// ---------- photographs ----------
const photos = [
  ['photo-astronaut', 'astronaut.png', 'NASA portrait of Eileen Collins via scikit-image', 'Public domain'],
  ['photo-coffee', 'coffee.png', 'Coffee cup by Rachel Michetti via scikit-image', 'CC0'],
  ['photo-cat', 'chelsea.png', 'Chelsea the cat by Stefan van der Walt via scikit-image', 'CC0'],
];
for (const [name, file, src, lic] of photos) {
  await sharp(path.join(here, 'sources', file)).removeAlpha().png().toFile(path.join(out, `${name}.png`));
  add(name, 'photo', src, lic);
}

// ---------- screenshots ----------
{
  const { chromium } = await import('playwright');
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  for (const s of ['code', 'dashboard', 'article']) {
    await page.goto('file://' + path.join(here, 'screens', `${s}.html`));
    await page.waitForTimeout(150);
    const buf = await page.screenshot({ type: 'png' });
    await sharp(buf).removeAlpha().png().toFile(path.join(out, `screenshot-${s}.png`));
    add(`screenshot-${s}`, 'screenshot', `Chromium rendering of bench/screens/${s}.html`, 'MIT (part of SMG)');
  }
  await browser.close();
}

// ---------- logos & icons (transparent) ----------
const mark = fs.readFileSync(path.join(here, 'screens', 'logo-mark.svg'), 'utf8').replace(/<svg[^>]*>/, '').replace('</svg>', '');
await svgToPng(
  'logo-smg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="256" viewBox="0 0 768 256">
    <g transform="translate(24 24) scale(3.25)">${mark}</g>
    <text x="270" y="170" font-family="DejaVu Sans" font-weight="bold" font-size="150" fill="#14162b" letter-spacing="-4">SMG</text>
  </svg>`,
  'logo',
  768,
);
await svgToPng(
  'logo-badge',
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><path id="arc" d="M96 256a160 160 0 1 1 320 0"/><path id="arc2" d="M86 256a170 170 0 0 0 340 0"/></defs>
    <circle cx="256" cy="256" r="236" fill="#1d3557"/>
    <circle cx="256" cy="256" r="214" fill="none" stroke="#f1faee" stroke-width="6" stroke-dasharray="2 10"/>
    <circle cx="256" cy="256" r="120" fill="#e63946"/>
    <path d="M256 170l24 50 55 7-40 38 10 54-49-26-49 26 10-54-40-38 55-7z" fill="#f1faee"/>
    <text font-family="DejaVu Sans" font-weight="bold" font-size="40" fill="#f1faee" letter-spacing="6"><textPath href="#arc" startOffset="50%" text-anchor="middle">NORTHWIND ROASTERS</textPath></text>
    <text font-family="DejaVu Sans" font-size="30" fill="#a8dadc" letter-spacing="8"><textPath href="#arc2" startOffset="50%" text-anchor="middle">EST. 1998</textPath></text>
  </svg>`,
  'logo',
  512,
);
const camera = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="12" y="34" width="104" height="74" rx="16" fill="#0ea5e9"/>
  <path d="M42 34l10-16h24l10 16z" fill="#0284c7"/>
  <circle cx="64" cy="71" r="26" fill="#e0f2fe"/><circle cx="64" cy="71" r="17" fill="#0c4a6e"/><circle cx="57" cy="64" r="6" fill="#bae6fd"/>
  <rect x="92" y="44" width="14" height="8" rx="3" fill="#7dd3fc"/></svg>`;
await svgToPng('icon-camera-128', camera, 'icon', 128);
await svgToPng(
  'icon-cloud-64',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 50h30a12 12 0 0 0 1-24 16 16 0 0 0-31-2A13 13 0 0 0 18 50z" fill="#8b5cf6"/><path d="M32 30v14m-7-7l7-7 7 7" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'icon',
  64,
);
await svgToPng('icon-favicon-32', fs.readFileSync(path.join(here, 'screens', 'logo-mark.svg'), 'utf8'), 'icon', 32);

// ---------- illustration ----------
await svgToPng(
  'illustration-landscape',
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640" viewBox="0 0 1024 640">
    <rect width="1024" height="640" fill="#ffe8d6"/>
    <circle cx="760" cy="170" r="90" fill="#ffb4a2"/><circle cx="760" cy="170" r="62" fill="#ff8c6b"/>
    <path d="M0 400L180 220 320 330 470 170 660 360 820 240 1024 390V640H0z" fill="#6d6875"/>
    <path d="M470 170l-52 54 34-8 18 22 22-30 30 10z" fill="#f8f9fa"/><path d="M180 220l-40 40 26-4 14 16 16-22 22 6z" fill="#f8f9fa"/>
    <path d="M0 470c120-50 260-60 400-20s300 40 420-10 160-30 204-20V640H0z" fill="#b5838d"/>
    <path d="M0 540c150-40 300-30 460 0s330 20 564-30V640H0z" fill="#e5989b"/>
    <path d="M430 640c40-60 120-90 200-100s140-40 150-90c30 60-40 110-140 130s-140 30-150 60z" fill="#90e0ef"/>
    ${[60, 120, 190, 860, 930, 985].map((x, i) => `<g transform="translate(${x} ${470 + (i % 3) * 18})"><rect x="-6" y="40" width="12" height="40" fill="#5e503f"/><path d="M0-30L34 48H-34z" fill="${i % 2 ? '#2d6a4f' : '#40916c'}"/></g>`).join('')}
    <g fill="#fff" opacity=".9"><ellipse cx="200" cy="110" rx="70" ry="22"/><ellipse cx="240" cy="96" rx="44" ry="22"/><ellipse cx="560" cy="80" rx="60" ry="18"/></g>
    <g fill="none" stroke="#6d6875" stroke-width="4" stroke-linecap="round"><path d="M340 120q10-10 20 0q10-10 20 0"/><path d="M400 150q8-8 16 0q8-8 16 0"/></g>
  </svg>`,
  'illustration',
  1024,
);

// ---------- gradients ----------
await svgToPng(
  'gradient-aurora',
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512" viewBox="0 0 1024 512">
    <defs>
      <radialGradient id="a" cx=".2" cy=".3" r=".7"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#4f46e5" stop-opacity="0"/></radialGradient>
      <radialGradient id="b" cx=".8" cy=".2" r=".6"><stop offset="0" stop-color="#ec4899"/><stop offset="1" stop-color="#ec4899" stop-opacity="0"/></radialGradient>
      <radialGradient id="c" cx=".6" cy=".9" r=".7"><stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#06b6d4" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1024" height="512" fill="#0b1020"/><rect width="1024" height="512" fill="url(#a)"/><rect width="1024" height="512" fill="url(#b)"/><rect width="1024" height="512" fill="url(#c)"/>
  </svg>`,
  'gradient',
  1024,
);
await svgToPng(
  'gradient-sunset',
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset=".55" stop-color="#f97316"/><stop offset="1" stop-color="#fde047"/></linearGradient></defs>
    <rect width="800" height="400" fill="url(#s)"/>
  </svg>`,
  'gradient',
  800,
);

for (const m of manifest) {
  const meta = await sharp(path.join(out, m.file)).metadata();
  m.width = meta.width;
  m.height = meta.height;
  m.hasAlpha = meta.hasAlpha;
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${manifest.length} images to ${path.relative(process.cwd(), out)}`);

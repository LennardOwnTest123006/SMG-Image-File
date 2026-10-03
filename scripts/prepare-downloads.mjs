#!/usr/bin/env node
// Copies release artefacts into apps/web/public/downloads/ and writes a manifest
// with sizes and SHA-256 checksums. Run after building @smg/codec and @smg/cli.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'apps/web/public/downloads');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const items = [
  { src: 'packages/cli/dist/smg.mjs', name: `smg-${version}.mjs`, kind: 'cli', description: 'Command-line tool (single file, Node.js ≥ 20). WebP/AVIF/SVG and benchmarks additionally need the optional sharp package (npm install sharp).' },
  { src: 'packages/codec/dist/smg-codec.js', name: `smg-codec-${version}.js`, kind: 'library', description: 'Codec library as one ES module (encode, decode, inspect, metrics). Zero dependencies.' },
  { src: 'packages/codec/dist/smg-codec-io.js', name: `smg-codec-io-${version}.js`, kind: 'library', description: 'IO helpers as one ES module (PNG/BMP/GIF, format detection, resize, ZIP).' },
  { src: 'docs/SPEC.md', name: `smg-spec-${version}.md`, kind: 'spec', description: 'SMG format specification (Markdown).' },
];

const files = [];
for (const it of items) {
  const srcPath = path.join(root, it.src);
  if (!fs.existsSync(srcPath)) throw new Error(`missing ${it.src} — build the packages first`);
  const data = fs.readFileSync(srcPath);
  fs.writeFileSync(path.join(out, it.name), data);
  files.push({ name: it.name, path: `/downloads/${it.name}`, kind: it.kind, description: it.description, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version, generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
console.log(`prepared ${files.length} downloads in ${path.relative(root, out)}`);

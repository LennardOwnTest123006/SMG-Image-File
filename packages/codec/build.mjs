// Builds the distributable library: dist/smg-codec.js (ESM) and dist/smg-codec-io.js.
import { build } from 'esbuild';
import fs from 'node:fs';

for (const [entry, out] of [['src/index.ts', 'dist/smg-codec.js'], ['src/io/index.ts', 'dist/smg-codec-io.js']]) {
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', minify: true, sourcemap: true, legalComments: 'eof', logLevel: 'warning' });
  console.log('built', out, (fs.statSync(out).size / 1024).toFixed(0), 'KiB');
}

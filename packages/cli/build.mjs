// Bundles the CLI into a single ESM file (dist/smg.mjs) runnable with Node ≥ 20.
// `sharp` stays external: it is optional and loaded on demand.
import { build } from 'esbuild';
import fs from 'node:fs';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/smg.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['sharp'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __smgCreateRequire } from 'node:module';\nconst require = __smgCreateRequire(import.meta.url);",
  },
  legalComments: 'eof',
  minify: false,
  logLevel: 'warning',
});
fs.chmodSync('dist/smg.mjs', 0o755);
console.log('built dist/smg.mjs', (fs.statSync('dist/smg.mjs').size / 1024).toFixed(0), 'KiB');

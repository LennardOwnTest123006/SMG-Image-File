import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import securityHeaders from './security-headers.json' with { type: 'json' };

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@smg/codec/io': fileURLToPath(new URL('../../packages/codec/src/io/index.ts', import.meta.url)),
      '@smg/codec': fileURLToPath(new URL('../../packages/codec/src/index.ts', import.meta.url)),
    },
  },
  server: { fs: { allow: [root] } },
  // Same security headers as production (netlify.toml) so E2E tests exercise the CSP.
  preview: { headers: securityHeaders },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // Never inline assets as data: URIs — keeps the strict CSP (font-src 'self') valid.
    assetsInlineLimit: 0,
  },
  define: {
    __APP_VERSION__: JSON.stringify('1.0.0'),
  },
});

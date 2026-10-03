import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

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
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  define: {
    __APP_VERSION__: JSON.stringify('1.0.0'),
  },
});

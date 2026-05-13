import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite config for the AgentX SPA shell.
 *
 * - Source root: `src/client/`
 * - Build output: `dist/client/`  (sibling to tsc's `dist/server/`)
 *
 * The Node server (`dist/server/index.js`) prefers serving `dist/client/index.html`
 * when present and falls back to the embedded HTML when the SPA isn't built.
 *
 * Service worker:
 *  - `src/client/service-worker.ts` is built as a second entry and emitted
 *    at `dist/client/service-worker.js` (root, NOT under /assets/) so its
 *    scope covers the whole app.
 *  - `__BUILD_ID__` is replaced at build time with a fresh value, so every
 *    deploy invalidates the previous SW cache.
 */

// Stable per-build identifier — drives the SW cache namespace.
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/client'),
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/client/index.html'),
        'service-worker': path.resolve(__dirname, 'src/client/service-worker.ts'),
      },
      output: {
        // The SW must live at the root of /dist/client so its scope is "/".
        // Everything else stays under /assets/ with content hashes.
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'service-worker'
            ? 'service-worker.js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { backendFingerprint } from '../server/src/codeVersion';

const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The backend code this dashboard is built against, so it can tell when the running
  // backend is a different (usually older, not restarted) version.
  define: {
    __BACKEND_FINGERPRINT__: JSON.stringify(backendFingerprint(fileURLToPath(new URL('../..', import.meta.url)))),
    __BUILT_AT__: JSON.stringify(Date.now()),
  },
  // three.js (~500 kB) is its own chunk, loaded only when the 3D view opens.
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/turtle': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});

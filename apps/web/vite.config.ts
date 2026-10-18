import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

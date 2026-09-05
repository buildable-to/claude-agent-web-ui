import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 3456);
// Serve the page under a path prefix (e.g. /agent/) when an app embeds it.
const base = (process.env.BASE_PATH ?? '/').replace(/\/?$/, '/');

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web'),
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/web'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      [`${base}api`]: `http://localhost:${serverPort}`,
      [`${base}ws`]: { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
  },
});

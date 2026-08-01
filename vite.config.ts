import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5175',
      '/login': 'http://127.0.0.1:5175',
      '/logout': 'http://127.0.0.1:5175',
      '/app': 'http://127.0.0.1:5175',
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '0.0.0.0' },
});

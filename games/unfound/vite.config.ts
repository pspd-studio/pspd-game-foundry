import { defineConfig } from 'vite';

// root는 games/unfound. data/*.json이 root 안에 있으므로 사본 없이 원본을 import한다.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { open: false },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    // Needed for top-level await in the wasm-pack output and WASM ESM integration.
    target: 'es2022',
    // three.js alone is ~1 MB minified; the single-chunk warning is expected.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
  test: {
    // Playwright specs live in e2e/ and are run by `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
      '/api': { target: 'http://127.0.0.1:8765' },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    // The preload polyfill would be the only non-module script; modern targets do not need it.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URIs into JS/CSS; keep everything as hashed same-origin files.
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

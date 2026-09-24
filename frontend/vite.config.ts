import { defineConfig, type Plugin } from 'vitest/config';
import { tokensToCss } from './src/tokens';

/** Serves `virtual:tokens.css`, generated from src/tokens.ts, so tokens have one source of truth. */
function tokensCss(): Plugin {
  const id = 'virtual:tokens.css';
  const resolved = '\0' + id;
  return {
    name: 'afterglow-tokens',
    resolveId: (source) => (source === id ? resolved : null),
    load: (source) => (source === resolved ? tokensToCss() : null),
  };
}

export default defineConfig({
  plugins: [tokensCss()],
  build: {
    target: 'es2022',
    // The preload polyfill would be the only non-module script; modern targets do not need it.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URIs into JS/CSS; keep everything as hashed same-origin files.
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    // Dev only: forward the API to the local Caddy stack (the production build is served by Caddy itself).
    proxy: { '/api': { target: 'https://localhost:8443', secure: false, changeOrigin: false } },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

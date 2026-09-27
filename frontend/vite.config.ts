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

/**
 * Fills %SITE_URL% in the HTML (link previews need absolute image URLs). Set AFTERGLOW_SITE_URL when building for
 * another domain; no trailing slash.
 */
function siteUrl(): Plugin {
  const url = (process.env['AFTERGLOW_SITE_URL'] ?? 'https://afterglow.name').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) throw new Error(`AFTERGLOW_SITE_URL must be https://host, got ${url}`);
  return { name: 'afterglow-site-url', transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', url) };
}

export default defineConfig({
  plugins: [tokensCss(), siteUrl()],
  build: {
    target: 'es2022',
    // The preload polyfill would be the only non-module script; modern targets do not need it.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URIs into JS/CSS; keep everything as hashed same-origin files.
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
    // Two pages: the app and the static privacy note.
    rollupOptions: { input: { main: 'index.html', privacy: 'privacy.html' } },
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

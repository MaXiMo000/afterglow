import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real stack (Caddy + API) so CSP and headers are the production ones.
// Start it with: docker compose -f deploy/compose.yaml up -d --build --wait
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'line' : 'list',
  use: {
    baseURL: process.env['AFTERGLOW_URL'] ?? 'https://localhost:8443',
    // Caddy's local internal CA is not in the test browser's trust store.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

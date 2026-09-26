import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// SECURITY T8 / T20: the page runs with zero CSP or Trusted Types violations and talks only to its own origin.
// The "controls are live" tests prove the policy is actually enforced, so removing a directive fails CI.

type Violation = { directive: string; blocked: string };

async function collectViolations(page: Page): Promise<() => Promise<Violation[]>> {
  // Init scripts are injected by the browser driver, not the page, so they are not subject to the page CSP.
  await page.addInitScript(() => {
    const store: { directive: string; blocked: string }[] = [];
    Object.defineProperty(window, '__cspViolations', { value: store });
    document.addEventListener('securitypolicyviolation', (e) => {
      store.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

test('landing page has no CSP or Trusted Types violations and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const violations = await collectViolations(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('after dark');
  await page.waitForLoadState('networkidle');

  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
});

test('only same-origin requests are made', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? '').origin;
  const foreign: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin) foreign.push(r.url());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(foreign).toEqual([]);
});

test('full walkthrough: no CSP/TT violations, same-origin only, nothing sensitive stored (T8, T20)', async ({ page, baseURL, context }) => {
  test.slow();
  const origin = new URL(baseURL ?? '').origin;
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin) foreign.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const violations = await collectViolations(page);
  await mock(page, 'c'.repeat(32));

  await page.goto('/');
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  await page.locator('#btnCity').click();
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  for (const k of ['/', 'Escape', 'i', 'm', 'c', 'Escape', 'Space', 'Space', 's', '5', '1']) await page.keyboard.press(k);
  await page.keyboard.press('p');
  await expect(page.locator('#photoBar')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  await download;
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await expect(page.locator('#tableView')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
  // Browser storage: no cookies, nothing in localStorage, and sessionStorage holds only numeric UI state.
  expect(await context.cookies()).toEqual([]);
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(stored.local).toEqual([]);
  for (const [, v] of stored.session) expect(v).toMatch(/^\d+(\.\d+)?$/);
});

test('privacy page: full header set, no CSP/TT violations, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const violations = await collectViolations(page);
  const res = await page.goto('/privacy.html');
  expect(res?.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  await page.waitForLoadState('networkidle');
  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
});

test('CSP is live: inline script does not execute', async ({ page }) => {
  await page.goto('/');
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    try {
      // Trusted Types rejects the plain string; if it ever got through, CSP must still block execution.
      s.textContent = 'window.__inlineRan = true';
    } catch {
      return 'blocked-by-trusted-types';
    }
    document.head.append(s);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true ? 'ran' : 'blocked-by-csp';
  });
  expect(ran).not.toBe('ran');
});

test('Trusted Types is live: innerHTML with a plain string throws', async ({ page }) => {
  await page.goto('/');
  const threw = await page.evaluate(() => {
    try {
      document.body.innerHTML = '<img src=x onerror="window.__xss=1">';
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  });
  expect(threw).toBe(true);
});

// page.evaluate() runs through DevTools, which is exempt from the page's eval policy, so eval cannot be probed
// from here. Instead: the policy must grant no unsafe-* source, and scripts/check-bundle.mjs rejects eval sinks.
test('CSP grants no unsafe sources', async ({ request }) => {
  const csp = (await request.get('/')).headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self';/);
  expect(csp).not.toMatch(/unsafe-|strict-dynamic|\*|https?:/);
});

test('page cannot be framed', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
});

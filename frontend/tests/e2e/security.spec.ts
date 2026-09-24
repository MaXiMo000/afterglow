import { expect, test, type Page } from '@playwright/test';

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

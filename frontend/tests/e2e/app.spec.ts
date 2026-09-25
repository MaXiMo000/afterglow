import { expect, test, type Page, type Route } from '@playwright/test';

// A3 flows against the real Caddy + CSP, with the API mocked so hostile and broken data can be injected.
const ID = 'a'.repeat(32);
const XSS = '<img src=x onerror="window.__xss=1">';

function result(over: { files?: unknown[]; dirs?: unknown[] } = {}): unknown {
  const dirs = over.dirs ?? [
    { name: 'core', files: 2, loc: 30, last: 1_700_000_000, bus_factor: 1, quiet: false },
    { name: `x${XSS}`, files: 1, loc: 5, last: 1_600_000_000, bus_factor: 1, quiet: true },
  ];
  const files = over.files ?? [
    { path: `core/${XSS}.py`, dir: 0, loc: 20, birth: 1_600_000_000, last: 1_700_000_000, changes: 40, changes_12m: 12, authors: 1, hot: true, dead: false },
    { path: 'core/"><script>window.__xss=2</script>.py', dir: 0, loc: 10, birth: 1_600_000_000, last: 1_690_000_000, changes: 5, changes_12m: 2, authors: 2, hot: false, dead: false },
    { path: `x${XSS}/old.py`, dir: 1, loc: 5, birth: 1_550_000_000, last: 1_600_000_000, changes: 1, changes_12m: 0, authors: 1, hot: false, dead: true },
  ];
  return {
    meta: {
      repo: 'acme/orbit', sha: 'b'.repeat(40), analyser: 1, generated_at: 1_700_000_100, commits: 46, files: files.length,
      people: 2, span: [1_550_000_000, 1_700_000_000], truncated: { files: false, commits: false, sizes: false },
    },
    dirs, files, coupling: [], people: [{ handle: 'Contributor 1', commits: 40, areas: [0] }],
    insights: { hotspots: [0], bus_factor: [0], quiet: [1], coupling: [] },
    timeline: [{ t: 1_550_000_000, commits: 46, added: 3 }],
  }; // prettier-ignore
}

async function mockApi(page: Page, body: unknown): Promise<void> {
  await page.route('**/api/v1/analyses', (r: Route) => r.fulfill({ status: 202, json: { id: ID, status: 'queued' } }));
  await page.route(`**/api/v1/analyses/${ID}/events`, (r: Route) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        { status: 'running', stage: 'cloning', n: 0, total: 0 },
        { status: 'running', stage: 'parsing', n: 20, total: 46 },
        { status: 'done', stage: 'done', n: 0, total: 0 },
      ].map((d) => `event: progress\ndata: ${JSON.stringify(d)}\n\n`).join(''),
    }),
  );
  await page.route(`**/api/v1/analyses/${ID}`, (r: Route) => r.fulfill({ status: 200, json: body }));
}

async function violations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const v: string[] = [];
    Object.defineProperty(window, '__v', { value: v });
    document.addEventListener('securitypolicyviolation', (e) => v.push(e.effectiveDirective));
  });
  return () => page.evaluate(() => (window as unknown as { __v: string[] }).__v);
}

test('hostile paths render as inert text everywhere (T5)', async ({ page }) => {
  const v = await violations(page);
  let dialog = false;
  page.on('dialog', (d) => ((dialog = true), void d.dismiss()));
  await mockApi(page, result());
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.click('button.go');
  await expect(page.locator('#log')).toContainText('Reading history: 20 of 46 commits');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  await page.click('#btnTable');
  await expect(page.locator('#files tbody')).toContainText(`core/${XSS}.py`);
  await expect(page.locator('#summaryBody')).toContainText(`x${XSS}`);
  expect(await page.locator('#files img, #summaryBody img, script:not([src])').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(dialog).toBe(false);
  expect(await v()).toEqual([]);
});

test('without WebGL2 the table is the UI (2D fallback)', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test shim: pretend the device has no WebGL2
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : orig.call(this, type as '2d', ...(rest as []));
    };
  });
  await mockApi(page, result());
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.click('button.go');
  await expect(page.locator('#tableView')).toBeVisible();
  await expect(page.locator('#files tbody tr')).toHaveCount(3);
  await expect(page.locator('#treemap')).toBeVisible();
});

for (const [name, body] of [
  ['NaN in data', JSON.parse(JSON.stringify(result()).replace('"loc":20', '"loc":1e999'))],
  ['file index out of range', result({ files: [{ path: 'a', dir: 9, loc: 1, birth: 1, last: 2, changes: 1, changes_12m: 1, authors: 1, hot: false, dead: false }] })],
  ['too many files', result({ files: Array.from({ length: 50_001 }, () => ({ path: 'a', dir: 0, loc: 1, birth: 1, last: 2, changes: 1, changes_12m: 1, authors: 1, hot: false, dead: false })) })],
] as const) {
  test(`a bad result is refused before rendering (T21): ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockApi(page, body);
    await page.goto('/?quality=simple');
    await page.fill('#repoInput', 'acme/orbit');
    await page.click('button.go');
    await expect(page.locator('#log li.fail')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/mode-city/);
    expect(errors).toEqual([]);
  });
}

test('API errors show plain reason text, never raw server text', async ({ page }) => {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '30' } }));
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.click('button.go');
  await expect(page.locator('#log li.fail')).toHaveText('Too many requests. Please wait a moment and try again.');
});

test('invalid input is caught in the form', async ({ page }) => {
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'https://evil.example/a/b');
  await page.click('button.go');
  await expect(page.locator('#formErr')).toContainText('owner/name');
  await expect(page.locator('body')).toHaveClass(/mode-hero/);
});

test('pasted GitHub URLs are accepted', async ({ page }) => {
  await mockApi(page, result());
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'https://github.com/acme/orbit.git');
  await page.click('button.go');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
});

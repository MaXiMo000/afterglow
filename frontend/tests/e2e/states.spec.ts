import { expect, test } from '@playwright/test';

// A6 empty/error states: every failure offers a way forward, and empty data says so plainly.
const ID = 'b'.repeat(32);

function result(files: unknown[]): unknown {
  return {
    meta: {
      repo: 'acme/orbit', sha: 'c'.repeat(40), analyser: 2, generated_at: 1_700_000_100, commits: 3, files: files.length,
      people: 1, span: [1_600_000_000, 1_700_000_000], truncated: { files: false, commits: false, sizes: false },
    },
    dirs: [{ name: 'core', files: files.length, loc: 10, last: 1_700_000_000, bus_factor: 1, quiet: false }],
    files, coupling: [], people: [{ handle: 'Contributor 1', commits: 3, areas: [0] }],
    insights: { hotspots: [], bus_factor: [], quiet: [], coupling: [] },
    timeline: [{ t: 1_600_000_000, commits: 3, added: 1 }],
  }; // prettier-ignore
}
const oneFile = [{ path: 'core/a.py', dir: 0, loc: 10, birth: 1_600_000_000, last: 1_700_000_000, changes: 3, changes_12m: 1, authors: 1, hot: false, dead: false }];

test('a transient failure offers Try again, and retrying works', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/analyses', (r) =>
    ++calls === 1
      ? r.fulfill({ status: 503, json: { error: 'busy' }, headers: { 'retry-after': '30' } })
      : r.fulfill({ status: 200, json: { id: ID, status: 'done' } }),
  );
  await page.route(`**/api/v1/analyses/${ID}`, (r) => r.fulfill({ status: 200, json: result(oneFile) }));
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.click('button.go');
  await expect(page.locator('#log li.fail')).toHaveText('The service is busy. Please try again in a minute.');
  await expect(page.locator('#btnRetry')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#log')).toContainText('Drawing the city');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  expect(calls).toBe(2);
});

test('a permanent failure offers Back, not Try again', async ({ page }) => {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 200, json: { id: ID, status: 'queued' } }));
  await page.route(`**/api/v1/analyses/${ID}/events`, (r) =>
    r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: progress\ndata: {"status":"failed","stage":"failed","n":0,"total":0,"reason":"not_found"}\n\n' }),
  );
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/private');
  await page.click('button.go');
  await expect(page.locator('#log li.fail')).toContainText('Only public repositories can be analysed');
  await expect(page.locator('#btnRetry')).toBeHidden();
  await expect(page.locator('#btnBack')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-hero/);
  await expect(page.locator('#repoInput')).toBeFocused();
});

test('a repository with no files at HEAD says so instead of drawing an empty city', async ({ page }) => {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 200, json: { id: ID, status: 'done' } }));
  await page.route(`**/api/v1/analyses/${ID}`, (r) => r.fulfill({ status: 200, json: result([]) }));
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/empty');
  await page.click('button.go');
  await expect(page.locator('#log li.fail')).toHaveText('This repository has no files at its latest commit, so there is no city to draw.');
  await expect(page.locator('body')).not.toHaveClass(/mode-story|mode-city/);
});

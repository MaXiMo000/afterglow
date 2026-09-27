import { expect, test } from '@playwright/test';
import { result } from './fixture';

// Analyser 3 fields (D4, D5, N3): per-quarter sparkline, heating/cooling trend, removals in compare mode, and
// files from before a truncated history window labelled as such.
const ID = 'd'.repeat(32);

function v3(windowStart?: number): unknown {
  const r = result() as {
    meta: { analyser: number; truncated: { commits: boolean } };
    files: { quarters?: number[]; changes: number; changes_12m: number; birth: number; last: number; path: string }[];
    timeline: { removed?: number }[];
  };
  r.meta.analyser = 3;
  r.meta.truncated.commits = true;
  r.files.forEach((f) => (f.quarters = []));
  r.files[0]!.quarters = [0, 1, 0, 0, 2, 3, 1, 4]; // core/f0.py: heating up
  r.files[1]!.quarters = [5, 4, 3, 2, 1, 0, 0, 1]; // tests/f1.py: cooling down
  Object.assign(r.files[2]!, { changes: 0, changes_12m: 0, birth: 1_450_000_000, last: 1_450_000_000 }); // legacy/f2.py
  r.timeline.forEach((m, i) => (m.removed = i % 2));
  if (windowStart) (r.meta as unknown as { span: number[] }).span[0] = windowStart;
  return r;
}

let windowStart: number | undefined;
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 200, json: { id: ID, status: 'done' } }));
  await page.route(`**/api/v1/analyses/${ID}`, (r) => r.fulfill({ status: 200, json: v3(windowStart) }));
  await page.goto('/?quality=simple#explore');
  await page.fill('#repoInput', 'acme/orbit');
  await page.press('#repoInput', 'Enter');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});

async function inspect(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.keyboard.press('/');
  await page.keyboard.type(path);
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector .path')).toHaveText(path);
}

test('the inspector shows changes per quarter and the trend', async ({ page }) => {
  await inspect(page, 'core/f0.py');
  const box = page.locator('#inspector');
  await expect(box.locator('.pill.heating')).toHaveText('heating up');
  await expect(box.locator('svg.quarters rect')).toHaveCount(8);
  await expect(box).toContainText('Heating up: 10 changes in the latest four quarters (the current one so far), 1 in the four before.');
  await expect(box).not.toContainText('Per-quarter history and per-author breakdowns are not in this analysis');
  await page.keyboard.press('Escape');
  await inspect(page, 'tests/f1.py');
  await expect(box.locator('.pill.cooling')).toHaveText('cooling down');
});

test('files from before the analysed history say so', async ({ page }) => {
  await inspect(page, 'legacy/f2.py');
  const box = page.locator('#inspector');
  await expect(box).toContainText('before');
  await expect(box).toContainText('Not changed in the 400 most recent commits');
  await expect(box).toContainText('No changes in the last eight quarters.');
});

test('compare mode counts removed files', async ({ page }) => {
  await page.keyboard.press('c');
  const legend = page.locator('#compareLegend');
  await expect(legend).toContainText('Removed in this window');
  await expect(legend).toContainText('counted by month, not drawn');
});

test.describe('a truncated history that starts inside the last two years', () => {
  test.beforeAll(() => void (windowStart = 1_700_000_000 - 200 * 86_400)); // ~Q2 2023, HEAD is Q4 2023
  test.afterAll(() => void (windowStart = undefined));
  test('marks unread quarters and claims no trend', async ({ page }) => {
    await inspect(page, 'core/f0.py');
    const box = page.locator('#inspector');
    await expect(box.locator('.pill.heating')).toHaveCount(0);
    await expect(box.locator('svg.quarters rect.na')).toHaveCount(6); // Q1 2022 .. Q1 2023 unread, Q2 2023 partial
    await expect(box).toContainText('No trend: the analysed history does not cover all eight quarters.');
    await expect(box).toContainText('The analysed history starts in Q2 2023');
  });
});

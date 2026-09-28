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
  if (owners) {
    // Analyser 5: owners per district. Contributor 1 alone knows core; tests is shared; legacy is Contributor 2's.
    const o = r as unknown as { meta: { analyser: number }; dirs: { owners?: unknown }[]; people: unknown[] };
    o.meta.analyser = 5;
    o.people.push({ handle: 'Contributor 2', commits: 120, areas: [1, 2] });
    o.dirs[0]!.owners = [{ person: 0, share: 0.9 }, { person: 1, share: 0.05 }];
    o.dirs[1]!.owners = [{ person: 0, share: 0.6 }, { person: 1, share: 0.4 }];
    o.dirs[2]!.owners = [{ person: 1, share: 1 }];
  }
  if (exactRemovals) {
    r.meta.analyser = 4;
    const times = r.timeline.flatMap((m) => Array.from({ length: m.removed ?? 0 }, () => (m as { t: number }).t + 86_400));
    Object.assign(r, { removals: times });
  }
  return r;
}

let windowStart: number | undefined;
let exactRemovals = false;
let owners = false;
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
  await expect(legend).toContainText('counted by whole month'); // analyser 3: monthly totals only
});

test.describe('an analysis with district owners (analyser 5)', () => {
  test.beforeAll(() => void (owners = true));
  test.afterAll(() => void (owners = false));
  test('what if a contributor left: the sentence, the list, the legend, and Esc', async ({ page }) => {
    await page.keyboard.press('i');
    await page.locator('#insights [data-tab="bus"]').click();
    await page.locator('#insights .whatif select').selectOption('0');
    await expect(page.locator('#insights .whatif')).toContainText('Without Contributor 1, 1 district');
    await expect(page.locator('#insights ol')).toContainText('core');
    await expect(page.locator('#riskLegend')).toContainText('What if Contributor 1 left?');
    await expect(page.locator('#announce')).toContainText('Without Contributor 1, 1 district');
    await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.locator('#riskLegend')).toBeHidden();
    await expect(page.locator('#announce')).toHaveText('What if cleared: all lights on.');
  });
});

test.describe('an analysis with removal times (analyser 4)', () => {
  test.beforeAll(() => void (exactRemovals = true));
  test.afterAll(() => void (exactRemovals = false));
  test('compare mode counts removals exactly, not by month', async ({ page }) => {
    await page.keyboard.press('c');
    const legend = page.locator('#compareLegend');
    await expect(legend).toContainText('Removed in this window');
    await expect(legend).toContainText('Removed files are counted, not drawn');
  });
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

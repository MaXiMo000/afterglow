import { expect, test, type Page } from '@playwright/test';

// A4 gate: chapter jumps and reverse scroll are seamless; wheel, keyboard, scrollbar (native scroll) all work;
// reduced motion gets native scrolling with static cards; deep links and scroll restore.
const ID = 'c'.repeat(32);

function result(): unknown {
  const dirs = [
    { name: 'core', files: 6, loc: 300, last: 1_700_000_000, bus_factor: 1, quiet: false },
    { name: 'tests', files: 6, loc: 200, last: 1_699_000_000, bus_factor: 2, quiet: false },
    { name: 'legacy', files: 6, loc: 90, last: 1_500_000_000, bus_factor: 1, quiet: true },
  ];
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: `${dirs[i % 3]!.name}/f${i}.py`, dir: i % 3, loc: 20 + i * 9, birth: 1_450_000_000 + i * 86_400 * 30,
    last: i % 3 === 2 ? 1_500_000_000 : 1_700_000_000 - i * 1000, changes: 40 - i, changes_12m: i % 3 === 2 ? 0 : 12 - (i % 6),
    authors: 1 + (i % 3), hot: i < 2, dead: i % 3 === 2,
  })); // prettier-ignore
  return {
    meta: {
      repo: 'acme/orbit', sha: 'd'.repeat(40), analyser: 1, generated_at: 1_700_000_100, commits: 400, files: 18,
      people: 5, span: [1_450_000_000, 1_700_000_000], truncated: { files: false, commits: false, sizes: false },
    },
    dirs, files, coupling: [{ a: 0, b: 1, count: 6, strength: 0.7 }],
    people: [{ handle: 'Contributor 1', commits: 300, areas: [0, 1] }],
    insights: { hotspots: [0, 1], bus_factor: [0, 2, 1], quiet: [2], coupling: [0] },
    timeline: [{ t: 1_450_000_000, commits: 100, added: 12 }, { t: 1_452_600_000, commits: 300, added: 6 }],
  }; // prettier-ignore
}

async function load(page: Page, url = '/?quality=simple'): Promise<void> {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 200, json: { id: ID, status: 'done' } }));
  await page.route(`**/api/v1/analyses/${ID}`, (r) => r.fulfill({ status: 200, json: result() }));
  await page.goto(url);
  await page.fill('#repoInput', 'acme/orbit');
  await page.click('button.go');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
}

const current = (page: Page) => page.locator('#rail button[aria-current]');

test('chapters come from the data and keys move between them, forwards and back', async ({ page }) => {
  await load(page);
  await expect(page.locator('#rail button')).toHaveCount(6);
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 1: First light');
  await page.keyboard.press('j');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 2: Growth');
  await expect(page).toHaveURL(/#chapter-2$/);
  await page.keyboard.press('PageDown');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 3: Hot streets');
  await page.keyboard.press('End');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 6: Yours');
  await page.keyboard.press('k');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 5: The people');
  await page.keyboard.press('Home');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 1: First light');
  await page.keyboard.press('4');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 4: Quiet quarters');
  await expect(page.locator('#chapter-4')).toContainText('legacy: 6 files');
});

test('wheel scrolls the story both ways', async ({ page }) => {
  await load(page);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 1500);
  await expect(current(page)).not.toHaveAttribute('aria-label', 'Chapter 1: First light');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -1500);
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 1: First light');
});

test('rail click, skip to the city, and back to the same place', async ({ page }) => {
  await load(page);
  await page.click('#rail button:nth-child(3)');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 3: Hot streets');
  await page.waitForTimeout(900); // let the eased flight and soft snap settle
  await page.click('#btnCity');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await expect(page).toHaveURL(/#explore$/);
  await page.click('#btnStory');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 3: Hot streets');
});

test('deep link lands on a chapter', async ({ page }) => {
  await load(page, '/?quality=simple#chapter-5');
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 5: The people');
});

test('last chapter hands over to the city', async ({ page }) => {
  await load(page);
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Open the city' }).click();
  await expect(page.locator('body')).toHaveClass(/mode-city/);
});

test('reduced motion: native scrolling (no hijack), scrollbar-style scrolling works', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page);
  expect(await page.evaluate(() => document.documentElement.classList.contains('lenis'))).toBe(false);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); // what dragging the scrollbar does
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 6: Yours');
  await page.evaluate(() => scrollTo(0, 0));
  await expect(current(page)).toHaveAttribute('aria-label', 'Chapter 1: First light');
});

test('story text is honest about definitions', async ({ page }) => {
  await load(page);
  await page.keyboard.press('3');
  await expect(page.locator('#chapter-3')).toContainText('three people or fewer');
  await page.keyboard.press('5');
  await expect(page.locator('#chapter-5')).toContainText('Counted by commits, not by lines');
});

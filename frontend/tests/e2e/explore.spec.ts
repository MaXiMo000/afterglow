import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// A5 gate: "keyboard-only walkthrough of every feature". After the repo is submitted with Enter, nothing here uses
// the mouse. Also: share links restore a view; hostile share links are ignored (SECURITY T15).
const ID = 'e'.repeat(32);

async function openCity(page: Page): Promise<void> {
  await mock(page, ID);
  await page.goto('/?quality=simple#explore');
  await page.locator('#repoInput').focus();
  await page.keyboard.type('acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const key = (page: Page, k: string) => page.keyboard.press(k);

test('every explore feature is reachable by keyboard alone', async ({ page }) => {
  test.slow(); // walks through every feature in one test
  await openCity(page);

  // Help overlay lists the keys; Esc closes it.
  await key(page, '?');
  await expect(page.locator('#help')).toBeVisible();
  await expect(page.locator('#help')).toContainText('Compare two dates');
  await key(page, 'Escape');
  await expect(page.locator('#help')).toBeHidden();

  // Palette: fuzzy search a file, Enter selects it and opens the inspector.
  await key(page, '/');
  await expect(page.locator('#palette')).toBeVisible();
  await page.keyboard.type('tests/f4');
  await expect(page.locator('#palList [role="option"]').first()).toContainText('tests/f4.py');
  await key(page, 'Enter');
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#inspector .path')).toHaveText('tests/f4.py');
  await expect(page.locator('#inspector a')).toHaveAttribute('href', `https://github.com/acme/orbit/blob/${'f'.repeat(40)}/tests/f4.py`);
  await key(page, 'f'); // frame the selection
  await key(page, 'Escape');
  await expect(page.locator('#inspector')).toBeHidden();

  // Palette also runs actions and finds districts and people.
  await key(page, 'Control+k');
  await page.keyboard.type('legacy/');
  await key(page, 'Enter');
  await expect(page.locator('#placeName')).toHaveText('legacy');

  // Insights, mini-map, compare, time.
  await key(page, 'i');
  await expect(page.locator('#insights')).toBeVisible();
  await expect(page.locator('#insights .rows')).toContainText('core/f0.py');
  await key(page, 'i');
  await expect(page.locator('#insights')).toBeHidden();
  await key(page, 'm');
  await expect(page.locator('#minimap')).toBeVisible();
  await key(page, 'c');
  await expect(page.locator('#compareLegend')).toBeVisible();
  await expect(page.locator('#compareLegend')).toContainText('Added in this window');
  await expect(page.locator('#compareLegend')).toContainText('removals are not shown');
  await key(page, 'Escape');
  await expect(page.locator('#compareLegend')).toBeHidden();
  await key(page, 'Space');
  await expect(page.locator('#timeline .play')).toHaveAttribute('aria-label', 'Pause history');
  await key(page, 'Space');
  await expect(page.locator('#timeline .play')).toHaveAttribute('aria-label', 'Play history');
  await key(page, ']');
  await expect(page.locator('#timeline .speed')).toHaveText('4\u00d7');
  await key(page, '[');
  await key(page, ',');
  await key(page, ',');
  await expect(page.locator('#timeline .track')).not.toHaveAttribute('aria-valuenow', '100');
  await key(page, '.');
  await key(page, 't');
  await expect(page.locator('#timeline')).toBeHidden();
  await key(page, 't');

  // Camera presets and view toggles announce themselves.
  for (const [k, label] of [['2', 'Street level'], ['3', 'Top-down'], ['4', 'Skyline'], ['5', 'Cinematic auto-orbit'], ['1', 'Overview']]) {
    await key(page, k!);
    await expect(page.locator('#announce')).toHaveText(`View: ${label}`);
  }
  await key(page, 'h');
  await key(page, 'r');
  await key(page, 'g');
  await expect(page.locator('#toast')).toHaveText('Coupling arcs off');
  await key(page, 'l');
  await expect(page.locator('#toast')).toHaveText('Lanterns off');
  for (const k of ['w', 'a', 's', 'd', 'q', 'e', 'ArrowLeft', 'ArrowUp', '+', '-']) await key(page, k);

  // Share link goes in the URL (and the clipboard when allowed).
  await key(page, 's');
  await expect(page).toHaveURL(/#v=1&r=acme\/orbit&c=[\d.,-]+&t=[\d.]+$/);

  // Photo mode hides the UI; Esc leaves it.
  await key(page, 'p');
  await expect(page.locator('body')).toHaveClass(/photo/);
  await expect(page.locator('#photoBar')).toBeVisible();
  await expect(page.locator('#hud')).toBeHidden();
  await key(page, 'Escape');
  await expect(page.locator('body')).not.toHaveClass(/photo/);

  // Table view and back to the story.
  await key(page, 'v');
  await expect(page.locator('#tableView')).toBeVisible();
  await key(page, 'Escape');
  await expect(page.locator('#tableView')).toBeHidden();
  await key(page, 'b');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
});

test('photo mode saves a PNG poster', async ({ page }) => {
  await openCity(page);
  await key(page, 'p');
  const download = page.waitForEvent('download');
  await key(page, 'Enter'); // Save PNG is focused on entering photo mode
  const d = await download;
  expect(d.suggestedFilename()).toBe('afterglow-acme-orbit.png');
});

test('a share link restores repo, camera and time', async ({ page }) => {
  await mock(page, ID);
  await page.goto('/?quality=simple#v=1&r=acme/orbit&c=1.000,0.500,80.000,0.000,0.000&t=0.5000');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await expect(page.locator('#timeline .track')).toHaveAttribute('aria-valuenow', '50');
});

for (const hash of ['#v=1&r=acme/orbit&t=<img src=x onerror=alert(1)>', '#v=1&r=https://evil.example/x', '#v=1&r=acme/orbit&c=1e9,0,0,0,0']) {
  test(`a hostile share link is ignored: ${hash.slice(0, 40)}`, async ({ page }) => {
    let posted = false;
    await page.route('**/api/v1/analyses', (r) => ((posted = true), r.fulfill({ status: 500, body: '' })));
    await page.goto(`/?quality=simple${hash}`);
    await page.waitForTimeout(800);
    await expect(page.locator('body')).toHaveClass(/mode-hero/);
    expect(posted).toBe(false);
  });
}

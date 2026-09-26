import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// A7 gate: axe (WCAG 2.2 A/AA) is clean in every UI state, focus order is sensible and visible, dialogs hand focus
// back, and the screen-reader summary carries the real numbers. Contrast over the WebGL canvas cannot be computed by
// axe (it reports those as "incomplete", not violations); the UI keeps text on its own dark scrims for that reason.
const ID = 'a'.repeat(32);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function openCity(page: Page, hash = '#explore'): Promise<void> {
  await mock(page, ID);
  await page.goto(`/?quality=simple${hash}`);
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
}

test('axe: hero', async ({ page }) => {
  await page.goto('/?quality=simple');
  await expect(page.locator('#honesty')).toContainText('Background');
  await axe(page);
});

test('axe: form error and failed analysis', async ({ page }) => {
  test.slow(); // several full axe scans over a live WebGL page
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'not a repo');
  await page.keyboard.press('Enter');
  await expect(page.locator('#formErr')).not.toBeEmpty();
  await axe(page);
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 503, json: { error: 'busy' } }));
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('#btnRetry')).toBeFocused();
  await axe(page);
});

test('axe: story', async ({ page }) => {
  await openCity(page, '#chapter-3');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  await axe(page);
});

test('axe: city, panels and dialogs', async ({ page }) => {
  test.slow(); // several full axe scans over a live WebGL page
  await openCity(page);
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await axe(page);
  await page.keyboard.press('/');
  await page.keyboard.type('core/f3');
  await expect(page.locator('#palList [role="option"]').first()).toBeVisible();
  await axe(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector')).toBeVisible();
  await axe(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('i');
  await page.keyboard.press('c');
  await page.keyboard.press('m');
  await expect(page.locator('#insights')).toBeVisible();
  await expect(page.locator('#compareLegend')).toBeVisible();
  await axe(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await expect(page.locator('#help')).toBeVisible();
  await axe(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  await expect(page.locator('#photoBar')).toBeVisible();
  await axe(page);
});

test('axe: table view and the no-WebGL fallback', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test override
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : orig.call(this, type as '2d', ...(rest as []));
    };
  });
  await openCity(page);
  await expect(page.locator('#tableView')).toBeVisible();
  await axe(page);
});

test('hero tab order is logical and every stop shows focus', async ({ page }) => {
  await page.goto('/?quality=simple');
  const stops: string[] = [];
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const cs = getComputedStyle(a.closest('.field') ?? a); // the repo input's ring is drawn on its field
      const shown = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      return `${a.id || a.textContent?.trim()}${shown ? '' : ' (NO FOCUS RING)'}`;
    });
    stops.push(s);
  }
  expect(stops).toEqual([
    'Skip to the text summary',
    'btnTable',
    'repoInput',
    'Build the city',
    'fastapi/typer',
    'pallets/flask',
    'tiangolo/sqlmodel',
  ]);
});

test('dialogs return focus to what opened them', async ({ page }) => {
  await openCity(page);
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  for (const [btn, dlg] of [['#btnHelp', '#help'], ['#btnSearch', '#palette']] as const) {
    await page.locator(btn).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(dlg)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(dlg)).toBeHidden();
    await expect(page.locator(btn)).toBeFocused();
  }  // The Close button works too, and also hands focus back.
  await page.locator('#btnHelp').focus();
  await page.keyboard.press('Enter');
  await page.locator('#btnHelpClose').click();
  await expect(page.locator('#help')).toBeHidden();
  await expect(page.locator('#btnHelp')).toBeFocused();
});

test('the screen-reader summary carries the real numbers', async ({ page }) => {
  await openCity(page);
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  const summary = page.locator('#summary');
  await expect(summary).toContainText('acme/orbit at commit fffffff: 18 files, 400 commits, 5 contributors');
  await expect(summary).toContainText('core/f0.py: 12 changes in the last 12 months');
  await expect(summary).toContainText('legacy: 6 files');
  // Reachable: the skip link moves focus to it.
  await page.goto('/?quality=simple');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#summary$/);
});

test('reduced motion: the cinematic view holds still (no auto-orbit)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openCity(page);
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.keyboard.press('5');
  await expect(page.locator('#announce')).toHaveText('View: Cinematic auto-orbit');
  await page.keyboard.press('s');
  const first = page.url();
  await page.waitForTimeout(1500);
  await page.keyboard.press('s');
  expect(page.url()).toBe(first); // the share link encodes the camera, so any drift would change it
});

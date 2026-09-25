import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// A6 visual regression baselines for the UI chrome. The WebGL canvas (and anything anchored to it) is hidden: GPU
// output is not pixel-deterministic across drivers. Baselines are Linux-only (generated in CI by the
// visual-baselines workflow); other platforms skip the comparison (see playwright.config.ts ignoreSnapshots).
const ID = 'd'.repeat(32);

async function load(page: Page, hash = ''): Promise<void> {
  await mock(page, ID);
  await page.goto(`/?quality=simple${hash}`);
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
}

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
};
/**
 * Hide what is not pixel-deterministic (WebGL output, the 3D-anchored callout, the mini-map drawn from the live
 * camera) with visibility:hidden. Playwright's `mask` paints over the element's whole box on top of everything, and
 * the canvas fills the viewport, so masking would hide the UI too. Setting style via CSSOM is allowed by the CSP.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    for (const id of ['gl', 'callout', 'minimap']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = 'hidden';
    }
  });
  await expect(page).toHaveScreenshot(name, { animations: 'disabled', maxDiffPixelRatio: 0.01 });
  await page.evaluate(() => {
    for (const id of ['gl', 'callout', 'minimap']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = '';
    }
  });
}

test('hero', async ({ page }) => {
  await page.goto('/?quality=simple');
  await expect(page.locator('#honesty')).toContainText('Background');
  await settle(page);
  await shot(page, 'hero.png');
});

test('error state with retry', async ({ page }) => {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 503, json: { error: 'busy' }, headers: { 'retry-after': '30' } }));
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('#btnRetry')).toBeVisible();
  await settle(page);
  await shot(page, 'error.png');
});

test('story chapter', async ({ page }) => {
  await load(page, '#chapter-3');
  await expect(page.locator('#rail button[aria-current]')).toHaveAttribute('aria-label', 'Chapter 3: Hot streets');
  await settle(page);
  await shot(page, 'story-hot.png');
});

test('city with insights and inspector', async ({ page }) => {
  await load(page, '#explore');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.keyboard.press('/');
  await page.keyboard.type('core/f3');
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector')).toBeVisible();
  await settle(page);
  await shot(page, 'city-inspector.png');
  await page.keyboard.press('Escape');
  await page.keyboard.press('i');
  await expect(page.locator('#insights')).toBeVisible();
  await settle(page);
  await shot(page, 'city-insights.png');
});

test('help overlay', async ({ page }) => {
  await load(page, '#explore');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.keyboard.press('?');
  await expect(page.locator('#help')).toBeVisible();
  await settle(page);
  await shot(page, 'help.png');
});

test('table view', async ({ page }) => {
  await load(page, '#explore');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.keyboard.press('v');
  await expect(page.locator('#tableView')).toBeVisible();
  await settle(page);
  await shot(page, 'table.png');
});

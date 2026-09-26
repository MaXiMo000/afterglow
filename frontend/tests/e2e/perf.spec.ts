import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// A7 budget gates that hold on any GPU (docs/PLAN.md section 6): draw calls per frame by tier, CLS 0, and no drawing
// while the tab is hidden. Frame rate and heap are hardware-dependent and are measured by scripts/profile.mjs instead.
const ID = 'b'.repeat(32);

declare global {
  interface Window {
    __draws: number[];
  }
}

/** Count WebGL2 draw calls per animation frame (test-only wrapper, installed before any app code runs). */
async function countDraws(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__draws = [];
    let n = 0;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const orig = proto[name]!;
      proto[name] = function (this: unknown, ...a: unknown[]) {
        n++;
        return orig.apply(this, a);
      };
    }
    const tick = (): void => {
      window.__draws.push(n);
      n = 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function maxDraws(page: Page, frames = 30): Promise<number> {
  await page.evaluate(() => (window.__draws = []));
  await page.waitForFunction((f) => window.__draws.length >= f, frames);
  return page.evaluate(() => Math.max(...window.__draws));
}

for (const [tier, budget] of [['simple', 60], ['cinematic', 150]] as const) {
  test(`draw calls per frame stay within budget: ${tier} <= ${budget}`, async ({ page }) => {
    test.slow(); // cinematic runs every pass on a software GPU in CI
    await countDraws(page);
    await mock(page, ID);
    await page.goto(`/?quality=${tier}#explore`);
    await page.fill('#repoInput', 'acme/orbit');
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toHaveClass(/mode-city/);
    await page.keyboard.press('i'); // panels and the mini-map do not draw with WebGL, but exercise the busiest view
    await page.keyboard.press('m');
    const city = await maxDraws(page);
    await page.keyboard.press('b');
    await expect(page.locator('body')).toHaveClass(/mode-story/);
    const story = await maxDraws(page);
    test.info().annotations.push({ type: 'draws', description: `${tier}: city ${city}, story ${story}` });
    expect(city).toBeGreaterThan(0);
    expect(Math.max(city, story)).toBeLessThanOrEqual(budget);
  });
}

test('no layout shift from hero to city (CLS 0)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await mock(page, ID);
  await page.goto('/?quality=simple');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBe(0);
});

test('a hidden tab draws nothing', async ({ page }) => {
  await countDraws(page);
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    (window as unknown as { __hide: (h: boolean) => void }).__hide = (h) => {
      hidden = h;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.goto('/?quality=simple');
  await page.waitForFunction(() => window.__draws.some((n) => n > 0), null, { timeout: 30_000 }); // renderer is up
  await expect(page.locator('#honesty')).toContainText('Background'); // demo city loaded: no warm-up draws pending
  await page.evaluate(() => (window as unknown as { __hide: (h: boolean) => void }).__hide(true));
  expect(await maxDraws(page, 30)).toBe(0);
});

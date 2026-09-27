import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// Navigation: browser history mirrors the screens (start page -> story -> city), so Back, Esc and Backspace step
// out one level, and the logo returns to the start page.
const ID = 'f'.repeat(32);

async function toStory(page: Page): Promise<void> {
  await mock(page, ID);
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
}

const mode = (page: Page, m: string) => expect(page.locator('body')).toHaveClass(new RegExp(`mode-${m}`));

test('browser Back steps city -> story -> start page, and Forward returns', async ({ page }) => {
  await toStory(page);
  await page.locator('#btnCity').click();
  await mode(page, 'city');
  await page.goBack();
  await mode(page, 'story');
  await page.goBack();
  await mode(page, 'hero');
  await page.goForward();
  await mode(page, 'story');
});

test('Backspace and Esc step back one level; the logo goes home', async ({ page }) => {
  await toStory(page);
  await page.locator('#btnCity').click();
  await mode(page, 'city');
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Backspace');
  await mode(page, 'story');
  await page.keyboard.press('Escape');
  await mode(page, 'hero');
  await expect(page.locator('#repoInput')).toBeFocused();
  // Logo from the city.
  await page.goForward();
  await mode(page, 'story');
  await page.locator('#btnCity').click();
  await mode(page, 'city');
  await page.locator('#brandHome').click();
  await mode(page, 'hero');
});

test('Backspace while typing in the search box edits text, it does not navigate', async ({ page }) => {
  await toStory(page);
  await page.locator('#btnCity').click();
  await mode(page, 'city');
  await page.keyboard.press('/');
  await page.keyboard.type('core');
  await page.keyboard.press('Backspace');
  await expect(page.locator('#palette input')).toHaveValue('cor');
  await mode(page, 'city');
});

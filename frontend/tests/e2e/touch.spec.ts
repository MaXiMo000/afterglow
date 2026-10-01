import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// Touch has no Esc: every mode a key turns on must have an on-screen way off. Only taps here, no keys.
const ID = 'd'.repeat(32);

async function action(page: Page, text: string): Promise<void> {
  await page.locator('#btnSearch').click();
  await page.locator('#palette input').fill(text);
  await page.locator('#palList li', { hasText: text }).first().click();
}

test('every mode a key turns on can be left by tapping', async ({ page }) => {
  test.slow();
  await mock(page, ID);
  await page.goto('/?quality=simple#explore');
  await page.fill('#repoInput', 'acme/orbit');
  await page.locator('#form .go').click();
  await expect(page.locator('body')).toHaveClass(/mode-city/);

  for (const [act, legend, close] of [
    ['Colour by file type', '#typeLegend', 'Turn colour by file type off'],
    ['Compare two dates', '#compareLegend', 'Stop comparing dates'],
  ] as const) {
    await action(page, act);
    await expect(page.locator(legend)).toBeVisible();
    await page.getByRole('button', { name: close }).click();
    await expect(page.locator(legend)).toBeHidden();
  }

  const leave = page.locator('#btnLeave');
  await expect(leave).toBeHidden();
  await action(page, 'Walk mode');
  await expect(page.locator('body')).toHaveClass(/walking/);
  await expect(leave).toHaveText('Leave walk mode');
  await leave.click();
  await expect(page.locator('body')).not.toHaveClass(/walking/);
  await expect(leave).toBeHidden();

  await action(page, 'core/');
  await action(page, 'Open the selected district');
  await expect(page.locator('#placeEy')).toHaveText('Inside');
  await expect(leave).toHaveText('Climb out');
  await leave.click();
  await expect(page.locator('#announce')).toHaveText('Back in the whole city.');
  await expect(leave).toBeHidden();

  await action(page, 'Record a video');
  await expect(page.locator('body')).toHaveClass(/recording/);
  await expect(leave).toHaveText('Stop recording');
  await leave.click();
  await expect(page.locator('body')).not.toHaveClass(/recording/);
  await expect(page.locator('#announce')).toHaveText('Recording cancelled.');
});

import { expect, test, type Page } from '@playwright/test';
import { mock } from './fixture';

// Living City key, guided walk, the More menu and the on-screen camera controls.
const ID = 'a'.repeat(32);

async function openCity(page: Page): Promise<void> {
  await mock(page, ID);
  await page.goto('/?quality=simple#explore');
  await expect(page.locator('body')).toHaveClass(/mode-hero/); // the app is up: the form is handled, not submitted
  await page.fill('#repoInput', 'acme/orbit');
  await page.locator('#form .go').click();
  await expect(page.locator('body')).toHaveClass(/mode-city/);
}

test('the city key is open by default, with real counts; 8 and the Key button toggle it; plain boxes switch inside', async ({ page }) => {
  test.slow(); // renders the city on a software GPU in CI
  await openCity(page);
  const key = page.locator('#livingLegend');
  await expect(key).toBeVisible();
  await expect(key).toContainText('Tree: a test file; tests make the parks (6)');
  await expect(page.locator('#btnKey')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('8');
  await expect(key).toBeHidden();
  await expect(page.locator('#btnKey')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#btnKey').click();
  await expect(key).toBeVisible();
  // The test window is 560 px tall: the key starts folded so it never covers the city; its title unfolds it.
  expect(await key.locator('details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
  await key.locator('summary').click();
  await key.getByRole('button', { name: 'Show plain boxes' }).click();
  await expect(key.getByRole('button', { name: 'Show the Living City' })).toHaveAttribute('aria-pressed', 'true');
  // Closing it is remembered on this device.
  await key.getByRole('button', { name: 'Hide the city key' }).click();
  await page.goto('/?quality=simple#explore');
  await expect(page.locator('body')).toHaveClass(/mode-hero/); // the app is up: the form is handled, not submitted
  await page.fill('#repoInput', 'acme/orbit');
  await page.locator('#form .go').click();
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await expect(key).toBeHidden();
});

test('guided walk: stops with captions, J/K jump, scrolling walks, Esc leaves', async ({ page }) => {
  test.slow(); // eased walking between stops, on a software GPU in CI
  await openCity(page);
  await page.locator('#btnMore').click();
  await page.locator('#btnWalkTour').click();
  await expect(page.locator('#placeEy')).toHaveText(/^Stop 1 of \d+$/);
  await expect(page.locator('#placeSub')).toContainText('Hotspot:');
  await expect(page.locator('#btnLeave')).toHaveText('Leave the guided walk');
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('j');
  await expect(page.locator('#placeEy')).toHaveText(/^Stop 2 of \d+$/);
  await page.keyboard.press('k');
  await expect(page.locator('#placeEy')).toHaveText(/^Stop 1 of \d+$/);
  await page.mouse.move(450, 280);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
  await expect(page.locator('#placeEy')).not.toHaveText(/^Stop 1 of/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#btnLeave')).toBeHidden();
  await expect(page.locator('#placeEy')).toHaveText('Exploring');
});

test('the More menu holds the less frequent actions and closes after one runs', async ({ page }) => {
  test.slow(); // renders the city on a software GPU in CI
  await openCity(page);
  const menu = page.locator('#moreMenu');
  await expect(menu).toBeHidden();
  await page.locator('#btnMore').click();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: /Copy a share link/ }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(/#v=1&r=acme\/orbit/);
  await page.locator('#btnMore').click();
  await page.keyboard.press('Escape'); // the menu takes Esc; the city stays open
  await expect(menu).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/mode-city/);
});

test('on-screen camera controls move the camera; drag moves the city like a map', async ({ page }) => {
  test.slow(); // renders the city on a software GPU in CI
  await openCity(page);
  const share = async (): Promise<string> => {
    await page.locator('#btnMore').click();
    await page.locator('#btnShare').click();
    return new URL(page.url()).hash;
  };
  const before = await share();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Turn left' }).click();
  await page.waitForTimeout(800);
  const turned = await share();
  expect(turned).not.toBe(before);
  const box = (await page.locator('#gl').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 - i * 12, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(await share()).not.toBe(turned);
});

test('Walk puts you on a street with an on-screen pad that walks while held; Esc leaves', async ({ page }) => {
  test.slow(); // renders the city on a software GPU in CI
  await openCity(page);
  await page.locator('#btnWalk').click();
  await expect(page.locator('body')).toHaveClass(/walking/);
  await expect(page.locator('#btnWalk')).toHaveAttribute('aria-pressed', 'true');
  const pad = page.locator('#walkPad');
  await expect(pad).toBeVisible();
  await expect(page.locator('#navCtl')).toBeHidden();
  const fwd = pad.getByRole('button', { name: 'Walk forward' });
  const box = (await fwd.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/walking/);
  await expect(pad).toBeHidden();
});

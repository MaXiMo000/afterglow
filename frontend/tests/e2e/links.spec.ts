import { expect, test } from '@playwright/test';
import { mock } from './fixture';

// Clean links (N1): /owner/name opens that repository's story; the address bar follows the loaded repository.
const ID = 'c'.repeat(32);

test('a clean link opens the story for that repository', async ({ page }) => {
  let asked = '';
  await mock(page, ID);
  await page.route('**/api/v1/analyses', async (r) => {
    asked = (r.request().postDataJSON() as { repo: string }).repo;
    await r.fulfill({ status: 200, json: { id: ID, status: 'done' } });
  });
  await page.goto('/acme/orbit?quality=simple');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  expect(asked).toBe('acme/orbit');
  await expect(page).toHaveURL(/\/acme\/orbit\?quality=simple#chapter-1$/);
  await page.goBack();
  await expect(page.locator('body')).toHaveClass(/mode-hero/);
  await expect(page).toHaveURL(/:\d+\/\?quality=simple$/);
});

test('a typed repository gets its clean link', async ({ page }) => {
  await mock(page, ID);
  await page.goto('/?quality=simple');
  await page.fill('#repoInput', 'acme/orbit');
  await page.press('#repoInput', 'Enter');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
  await expect(page).toHaveURL(/\/acme\/orbit\?quality=simple#chapter-1$/);
});

test('paths that are not a repository show the start page', async ({ page }) => {
  let asked = false;
  await page.route('**/api/v1/analyses', (r) => ((asked = true), r.abort()));
  for (const path of ['/a/b/c', '/assets/missing.js', '/x/%3Cimg%20src%3Dx%3E']) {
    await page.goto(path);
    await expect(page.locator('body')).toHaveClass(/mode-hero/);
    await expect(page).toHaveURL(/:\d+\/$/);
  }
  expect(asked).toBe(false);
});

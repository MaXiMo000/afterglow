// Manual story walkthrough on the live stack: screenshots per chapter via keys, reverse via wheel, then skip.
import { chromium } from '@playwright/test';
const repo = process.argv[2] ?? 'pallets/flask';
const out = process.argv[3] ?? 'shots';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));
await page.goto('https://localhost:8443/');
await page.fill('#repoInput', repo);
await page.click('button.go');
await page.waitForSelector('body.mode-story', { timeout: 120000 });
await page.waitForTimeout(1500);
const n = await page.locator('#rail button').count();
for (let i = 0; i < n; i++) {
  if (i) await page.keyboard.press('j');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/story-${i + 1}.png` });
  console.log('chapter', i + 1, await page.locator('#rail button[aria-current]').getAttribute('aria-label'), 'hash', await page.evaluate(() => location.hash));
}
for (let k = 0; k < 8; k++) (await page.mouse.wheel(0, -400), await page.waitForTimeout(80));
await page.waitForTimeout(1500);
console.log('after reverse wheel', await page.locator('#rail button[aria-current]').getAttribute('aria-label'));
await page.click('#btnCity');
await page.waitForTimeout(800);
console.log('mode', await page.evaluate(() => document.body.className), 'hash', await page.evaluate(() => location.hash));
await page.screenshot({ path: `${out}/story-to-city.png` });
console.log('problems', JSON.stringify(problems));
await browser.close();

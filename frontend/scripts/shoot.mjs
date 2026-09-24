// Manual smoke run against the live local stack: screenshots of hero -> loading -> city, console errors, timings.
// Usage: node scripts/shoot.mjs [owner/name] [outdir]   (needs the stack with the worker running)
import { chromium } from '@playwright/test';

const repo = process.argv[2] ?? 'fastapi/typer';
const out = process.argv[3] ?? 'shots';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'], headless: true });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const t0 = Date.now();
await page.goto('https://localhost:8443/');
await page.waitForFunction(() => document.querySelector('#honesty')?.textContent?.includes('Background'), null, { timeout: 20000 });
await page.waitForTimeout(1500);
console.log('hero ready ms', Date.now() - t0);
await page.screenshot({ path: `${out}/1-hero.png` });
await page.fill('#repoInput', repo);
await page.click('button.go');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/2-loading.png` });
await page.waitForSelector('body.mode-city', { timeout: 120000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/3-city.png` });
const box = await page.locator('#gl').boundingBox();
for (let i = 0; i < 12; i++) {
  await page.mouse.move(box.x + box.width * (0.42 + i * 0.012), box.y + box.height * 0.5);
  await page.waitForTimeout(120);
  if (await page.locator('#tip:not([hidden])').count()) break;
}
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/4-hover.png` });
const fps = await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      const t = performance.now();
      const f = () => (++n < 120 ? requestAnimationFrame(f) : r(Math.round((n * 1000) / (performance.now() - t))));
      requestAnimationFrame(f);
    }),
);
console.log('fps (headless, this machine)', fps);
await page.click('#btnTable');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/5-table.png` });
console.log('problems', JSON.stringify(problems, null, 1));
await browser.close();

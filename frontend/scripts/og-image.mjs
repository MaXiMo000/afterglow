// Renders public/og.jpg, the link-preview image (Open Graph / WhatsApp / Slack / X), from the real scene.
//
//   npm run build && (serve dist with the production headers) && node scripts/og-image.mjs
//
// The page's own demo city is the backdrop; the UI is hidden and a card is drawn on top. The words sit inside the
// centred 630 px square because WhatsApp and some chat apps crop previews to a square. The output must stay a
// baseline JPEG under 300 KB (WhatsApp drops larger images); the script checks both. It is a build-time tool only:
// it relaxes CSP in its own browser to add the card, which the shipped page never does.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const URL = process.env.AFTERGLOW_URL ?? 'https://localhost:8443/';
const OUT = new globalThis.URL('../public/og.jpg', import.meta.url);
const MAX_BYTES = 300_000;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, bypassCSP: true, viewport: { width: 1200, height: 630 } });
await page.goto(`${URL}?quality=cinematic`);
await page.waitForFunction(() => document.body.classList.contains('mode-hero'));
await page.waitForTimeout(6000); // let the city grow in and the camera settle

await page.addStyleTag({
  content: `
  body > *:not(#stage):not(#og) { visibility: hidden !important; }
  #scrim { display: none !important; }
  #og { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; text-align: center;
    background: radial-gradient(ellipse 46% 60% at 50% 50%, rgba(6,10,20,.82), rgba(6,10,20,.35) 70%, rgba(6,10,20,0) 100%); }
  #og .in { display: flex; flex-direction: column; align-items: center; gap: 18px; width: 640px; }
  #og .brand { font: 600 22px/1 'IBM Plex Mono', monospace; letter-spacing: .32em; color: #f3eee3; display: flex; gap: 14px; align-items: center; }
  #og .dot { width: 18px; height: 18px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #ffd08a, #ff9a3c 60%, #c2611a); box-shadow: 0 0 18px #ff9a3c; }
  #og h1 { margin: 0; font: 500 92px/.95 'Cormorant Garamond', serif; color: #f3eee3; letter-spacing: -.01em; }
  #og h1 em { color: #f08fb0; font-style: italic; display: block; }
  #og p { margin: 0; font: 400 25px/1.35 'Instrument Sans', sans-serif; color: #d9d4c8; max-width: 620px; }
  #og p span { display: block; }
  #og .tags { font: 500 17px/1 'IBM Plex Mono', monospace; color: #ffb45e; letter-spacing: .06em; }`,
});
await page.evaluate(() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const root = el('div');
  root.id = 'og';
  const inner = el('div', 'in');
  const brand = el('div', 'brand');
  brand.append(el('span', 'dot'), el('span', '', 'AFTERGLOW'));
  const h1 = el('h1', '', 'Your codebase,');
  h1.append(el('em', '', 'after dark.'));
  const sub = el('p');
  sub.append(el('span', '', 'Any public GitHub repo,'), el('span', '', 'grown into a glowing night city.'));
  inner.append(
    brand,
    h1,
    sub,
    el('div', 'tags', 'hotspots · bus factor · hidden coupling'),
  );
  root.append(inner);
  document.body.append(root);
});
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
const jpg = await page.screenshot({ type: 'jpeg', quality: 84 });
await browser.close();

// SOF0 (baseline) rather than SOF2 (progressive): some preview crawlers skip progressive JPEGs.
const sof = jpg.findIndex((b, i) => b === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2));
if (sof < 0 || jpg[sof + 1] !== 0xc0) throw new Error('screenshot is not a baseline JPEG');
if (jpg.length > MAX_BYTES) throw new Error(`og.jpg is ${jpg.length} bytes; link previews need < ${MAX_BYTES}`);
const before = readFileSync(OUT).length;
writeFileSync(OUT, jpg);
console.log(`wrote ${OUT.pathname} (${jpg.length} bytes, was ${before})`);

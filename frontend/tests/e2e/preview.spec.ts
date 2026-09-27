import { expect, test } from '@playwright/test';

// Link previews (WhatsApp, Slack, X, iMessage): crawlers read these tags without running scripts.
test('link-preview tags point at an absolute, small, baseline JPEG', async ({ page, request }) => {
  await page.goto('/');
  const meta = async (sel: string): Promise<string> => (await page.locator(sel).getAttribute('content')) ?? '';
  const image = await meta('meta[property="og:image"]');
  expect(image).toMatch(/^https:\/\/[^/]+\/og\.jpg\?v=\d+$/);
  expect(await meta('meta[property="og:image:secure_url"]')).toBe(image);
  expect(await meta('meta[name="twitter:image"]')).toBe(image);
  expect(await meta('meta[property="og:image:type"]')).toBe('image/jpeg');
  expect(await meta('meta[property="og:image:width"]')).toBe('1200');
  expect(await meta('meta[property="og:image:height"]')).toBe('630');
  expect(await meta('meta[property="og:url"]')).toMatch(/^https:\/\/[^/]+\/$/);
  for (const sel of ['og:title', 'og:description', 'og:image:alt']) expect(await meta(`meta[property="${sel}"]`)).not.toBe('');

  const res = await request.get(new URL(image).pathname + new URL(image).search);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/jpeg');
  const body = await res.body();
  expect(body.length).toBeLessThan(300_000); // WhatsApp drops larger preview images
  const sof = body.findIndex((b, i) => b === 0xff && (body[i + 1] === 0xc0 || body[i + 1] === 0xc2));
  expect(body[sof + 1]).toBe(0xc0); // baseline, not progressive
});

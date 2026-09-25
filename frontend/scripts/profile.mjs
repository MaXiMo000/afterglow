// A7 profiling against the live stack (docs/PERF-LOG.md). Real GPU via ANGLE; CPU slowdown via CDP as a stand-in for
// slower devices. It is NOT a real phone: record results as "desktop, N x CPU throttle", never as device numbers.
//
//   node scripts/profile.mjs frames [repo]        frame time, first frame, worst input delay: tier x CPU throttle
//   node scripts/profile.mjs soak [repo] [min]    JS heap after forced GC, once a minute, while exploring
import { chromium } from '@playwright/test';

const [mode = 'frames', repo = 'pallets/flask', minutes = '10'] = process.argv.slice(2);
const URL = process.env.AFTERGLOW_URL ?? 'https://localhost:8443/';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function open(tier, throttle, net) {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  // Fast 4G-like link (Lighthouse "mobile" preset): 150 ms RTT, 1.6 Mbps down, 750 kbps up.
  if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 });
  await page.addInitScript(() => {
    const w = window;
    w.__ft = [];
    w.__first = 0;
    w.__inp = 0;
    w.__slow = [];
    const proto = WebGL2RenderingContext.prototype;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[name];
      proto[name] = function (...a) {
        if (!w.__first) w.__first = performance.now();
        return orig.apply(this, a);
      };
    }
    let last = 0;
    const tick = (t) => {
      if (last) w.__ft.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        w.__inp = Math.max(w.__inp, e.duration);
        if (e.duration >= 100) w.__slow.push(`${e.name}:${e.target?.id || e.target?.nodeName || '?'} ${e.duration}ms`);
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  });
  await page.goto(`${URL}?quality=${tier}`);
  return { page, cdp };
}

const stats = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { n: s.length, p50: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), over16: ((100 * s.filter((x) => x > 16.9).length) / s.length).toFixed(0) + '%' };
};

async function toCity(page) {
  await page.fill('#repoInput', repo);
  await page.keyboard.press('Enter');
  await page.waitForSelector('body.mode-story', { timeout: 180_000 });
}

if (mode === 'frames') {
  console.log('tier       cpu  first-frame(4G)  story p50/p95/>16.7ms   city p50/p95/>16.7ms   worst event');
  for (const throttle of (process.env.CPU ?? '1,4,6').split(',').map(Number))
    for (const tier of ['simple', 'balanced', 'cinematic']) {
      const { page } = await open(tier, throttle, true);
      await page.waitForFunction(() => window.__first > 0, null, { timeout: 60_000 });
      const first = await page.evaluate(() => window.__first);
      await toCity(page);
      await page.waitForTimeout(1500);
      await page.evaluate(() => (window.__ft = []));
      for (let i = 0; i < 7; i++) (await page.keyboard.press('j'), await page.waitForTimeout(1300));
      const story = await page.evaluate(() => window.__ft);
      await page.click('#btnCity');
      await page.waitForSelector('body.mode-city');
      await page.waitForTimeout(1200);
      await page.evaluate(() => (window.__ft = []));
      for (const k of ['5', 'a', 'a', 'w', 'q', '2', 'i', 'Space', 'm', '1']) (await page.keyboard.press(k), await page.waitForTimeout(700));
      const city = await page.evaluate(() => window.__ft);
      const inp = await page.evaluate(() => window.__inp);
      const f = (s) => `${s.p50}/${s.p95}/${s.over16}`.padEnd(22);
      const slow = await page.evaluate(() => window.__slow);
      console.log(`${tier.padEnd(10)} ${String(throttle).padStart(2)}x  ${(first / 1000).toFixed(2).padStart(6)} s         ${f(stats(story))} ${f(stats(city))} ${inp.toFixed(0)} ms ${slow.join(', ')}`);
      await page.close();
    }
} else {
  const { page, cdp } = await open('cinematic', 1, false);
  await toCity(page);
  await page.click('#btnCity');
  await page.waitForSelector('body.mode-city');
  let dom = '';
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const c = await cdp.send('Memory.getDOMCounters');
    dom = `nodes ${c.nodes}, listeners ${c.jsEventListeners}`;
    return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6;
  };
  const keys = ['1', '2', '3', '4', '5', 'a', 'd', 'w', 's', 'i', 'i', 'm', 'm', 'c', 'Escape', 'Space', 'Space', 'v', 'Escape', 'b', 'j', 'j', 'c'];
  const samples = [await heap()];
  console.log(`minute 0: ${samples[0].toFixed(1)} MB, ${dom}`);
  for (let m = 1; m <= Number(minutes); m++) {
    const end = Date.now() + 60_000;
    let k = 0;
    while (Date.now() < end) {
      if (await page.evaluate(() => document.body.classList.contains('mode-story'))) await page.click('#btnCity').catch(() => {});
      await page.keyboard.press(keys[k++ % keys.length]);
      await page.waitForTimeout(250);
    }
    samples.push(await heap());
    console.log(`minute ${m}: ${samples.at(-1).toFixed(1)} MB, ${dom}`);
  }
  const growth = samples.at(-1) - samples[1];
  console.log(`start ${samples[0].toFixed(1)} MB, max ${Math.max(...samples).toFixed(1)} MB, growth after warm-up ${growth.toFixed(1)} MB`);
}
await browser.close();

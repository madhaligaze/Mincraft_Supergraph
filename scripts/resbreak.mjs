/**
 * Per-pass GPU cost at two internal resolutions.
 *
 * Scaling resolution by 4x only moved total GPU time from 34 ms to 24 ms, which
 * means most of the frame does not depend on pixel count at all. Since the
 * frame has to fit inside 16.7 ms to reach 60 Hz, that resolution-independent
 * remainder is the whole problem — this prints exactly which passes make it up.
 *
 * Usage: node scripts/resbreak.mjs [url] [preset]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';
const PRESET = process.argv[3] ?? 'medium';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,720',
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-frame-rate-limit',
    '--enable-webgl-developer-extensions',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);
await page.evaluate(() => document.getElementById('overlay')?.setAttribute('hidden', ''));

await new Promise((r) => setTimeout(r, 25000));
await page.evaluate((p) => {
  window.supergraph.setPreset(p);
  window.supergraph.setTime(0.36);
  window.supergraph.findViewpoint(48);
}, PRESET);
await new Promise((r) => setTimeout(r, 15000));

async function sample(scale) {
  await page.evaluate((s) => {
    window.supergraph.setSetting('resolutionScale', s);
    window.supergraph.enableGpuProfiler(true);
  }, scale);
  await new Promise((r) => setTimeout(r, 10000));

  const start = Date.now();
  while (Date.now() - start < 12000) {
    await page.evaluate((t) => window.supergraph.look(t * 0.5, -0.08), (Date.now() - start) / 1000);
    await new Promise((r) => setTimeout(r, 130));
  }
  return page.evaluate(() => ({
    gpu: window.supergraph.gpuTimings(),
    stats: window.supergraph.stats(),
  }));
}

const high = await sample(1.0);
const low = await sample(0.5);

const map = new Map();
for (const t of high.gpu) map.set(t.name, { high: t.ms, low: 0 });
for (const t of low.gpu) {
  const e = map.get(t.name) ?? { high: 0, low: 0 };
  e.low = t.ms;
  map.set(t.name, e);
}

const rows = [...map.entries()]
  .map(([name, v]) => ({
    name,
    high: v.high,
    low: v.low,
    // What survives a 4x cut in pixels is work that does not scale with them.
    fixed: Math.min(v.high, v.low),
    perPixel: Math.max(0, v.high - v.low),
  }))
  .sort((a, b) => b.fixed - a.fixed);

console.log(`\n${high.stats.render.internalWidth}x${high.stats.render.internalHeight}` +
  ` против ${low.stats.render.internalWidth}x${low.stats.render.internalHeight} (в 4 раза меньше пикселей)\n`);
console.log('проход              1.00x    0.50x   не зависит   зависит');
console.log('-----------------------------------------------------------');
let fixedTotal = 0;
let pixelTotal = 0;
for (const r of rows) {
  fixedTotal += r.fixed;
  pixelTotal += r.perPixel;
  console.log(
    `${r.name.padEnd(18)} ${r.high.toFixed(2).padStart(6)}  ${r.low.toFixed(2).padStart(6)}` +
    `  ${r.fixed.toFixed(2).padStart(9)}  ${r.perPixel.toFixed(2).padStart(8)}`,
  );
}
console.log('-----------------------------------------------------------');
console.log(`${'итого'.padEnd(18)} ${(fixedTotal + pixelTotal).toFixed(2).padStart(6)}` +
  `          ${fixedTotal.toFixed(2).padStart(9)}  ${pixelTotal.toFixed(2).padStart(8)}`);
console.log(`\nбюджет 60 Гц — 16.7 мс; неснижаемая часть сейчас ${fixedTotal.toFixed(1)} мс`);

writeFileSync('scripts/resbreak.json', JSON.stringify({ preset: PRESET, rows }, null, 2));
await browser.close();

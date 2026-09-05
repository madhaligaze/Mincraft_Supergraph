/**
 * How much internal resolution buys, at full medium quality.
 *
 * The draw-call probe showed the frame is neither vertex- nor submission-bound:
 * CPU time in render() stays flat while the draw count rises, and the render
 * distance barely moves the GPU. That leaves per-pixel cost, which this
 * measures directly — and it decides whether 60 fps is reachable by rendering
 * smaller and upscaling, rather than by cutting quality.
 *
 * Usage: node scripts/resscale.mjs [url] [preset]
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
  window.supergraph.enableGpuProfiler(true);
}, PRESET);
await new Promise((r) => setTimeout(r, 15000));

console.log(`preset ${PRESET}, качество не меняется — только внутреннее разрешение\n`);
const rows = [];

for (const scale of [1.0, 0.85, 0.7, 0.6, 0.5]) {
  await page.evaluate((s) => window.supergraph.setSetting('resolutionScale', s), scale);
  await new Promise((r) => setTimeout(r, 9000));
  await page.evaluate(() => window.supergraph.resetFrameTimes());

  const start = Date.now();
  while (Date.now() - start < 10000) {
    await page.evaluate((t) => window.supergraph.look(t * 0.5, -0.08), (Date.now() - start) / 1000);
    await new Promise((r) => setTimeout(r, 120));
  }

  const sample = await page.evaluate(() => ({
    gpu: window.supergraph.gpuTimings(),
    stats: window.supergraph.stats(),
    times: window.supergraph.frameTimes(),
  }));

  const gpuTotal = sample.gpu.reduce((a, b) => a + b.ms, 0);
  const sorted = [...sample.times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const mean = sample.times.reduce((a, b) => a + b, 0) / Math.max(sample.times.length, 1);

  const row = {
    scale,
    internal: `${sample.stats.render.internalWidth}x${sample.stats.render.internalHeight}`,
    pixelsK: Math.round(sample.stats.render.internalWidth * sample.stats.render.internalHeight / 1000),
    gpuMs: Number(gpuTotal.toFixed(2)),
    fpsMedian: Number((1000 / median).toFixed(1)),
    fpsMean: Number((1000 / mean).toFixed(1)),
  };
  rows.push(row);
  console.log(
    `scale ${row.scale.toFixed(2)}  ${row.internal.padEnd(9)} ${String(row.pixelsK).padStart(4)}k px` +
    `  GPU ${String(row.gpuMs).padStart(6)} ms   медиана ${String(row.fpsMedian).padStart(5)} fps` +
    `   среднее ${String(row.fpsMean).padStart(5)} fps`,
  );
}

writeFileSync('scripts/resscale.json', JSON.stringify({ preset: PRESET, rows }, null, 2));
await browser.close();

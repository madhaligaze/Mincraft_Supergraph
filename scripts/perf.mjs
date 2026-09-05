/**
 * Benchmark on the real GPU.
 *
 * Runs Chrome with hardware acceleration (not SwiftShader) and measures frame
 * times at each quality preset while the camera slowly turns, so the numbers
 * include chunk streaming and shadow-cascade updates rather than a static view.
 *
 * Usage: node scripts/perf.mjs [url] [secondsPerPreset]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SECONDS = Number(process.argv[3] ?? 14);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,720',
    // Force the real driver. Without these the new headless mode silently
    // falls back to SwiftShader and the numbers mean nothing.
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-frame-rate-limit',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => {
    const play = document.getElementById('play');
    return play && !play.disabled;
  },
  { timeout: 300000, polling: 500 },
);

await page.evaluate(() => {
  document.getElementById('overlay')?.setAttribute('hidden', '');
});

const gpu = await page.evaluate(() => window.supergraph.gpu);
console.log(`GPU: ${gpu}`);
if (/swiftshader|software/i.test(gpu)) {
  console.log('WARNING: software rendering — these numbers are meaningless.');
}

// Settle: let the world stream in and find an open viewpoint.
await new Promise((r) => setTimeout(r, 25000));
const spot = await page.evaluate(() => window.supergraph.findViewpoint(48));
console.log(`viewpoint: ${JSON.stringify(spot)}`);
await new Promise((r) => setTimeout(r, 15000));

const results = [];

for (const preset of ['low', 'medium', 'high', 'ultra']) {
  const applied = await page.evaluate((p) => {
    const s = window.supergraph.setPreset(p);
    window.supergraph.setTime(0.36);
    return {
      renderDistance: s.renderDistance,
      resolutionScale: s.resolutionScale,
      shadowMapSize: s.shadowMapSize,
      cascades: s.shadowCascades,
      cloudSteps: s.cloudSteps,
      grassDensity: s.grassDensity,
    };
  }, preset);

  // Let streaming and shader recompiles finish before sampling.
  await new Promise((r) => setTimeout(r, 18000));
  await page.evaluate(() => window.supergraph.resetFrameTimes());

  // Slowly rotate through the sample window so the numbers include the cost of
  // re-culling, re-fitting cascades and streaming new chunks into view.
  const start = Date.now();
  while (Date.now() - start < SECONDS * 1000) {
    await page.evaluate((t) => {
      window.supergraph.look(t * 0.55, -0.08);
    }, (Date.now() - start) / 1000);
    await new Promise((r) => setTimeout(r, 120));
  }

  const { times, render, world } = await page.evaluate(() => ({
    times: window.supergraph.frameTimes(),
    render: window.supergraph.stats().render,
    world: window.supergraph.stats().world,
  }));

  if (times.length < 10) {
    console.log(`${preset}: not enough samples`);
    continue;
  }

  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];

  const row = {
    preset,
    ...applied,
    internal: `${render.internalWidth}x${render.internalHeight}`,
    fpsMean: (1000 / mean).toFixed(1),
    fpsMedian: (1000 / median).toFixed(1),
    fps1PercentLow: (1000 / p99).toFixed(1),
    msMean: mean.toFixed(2),
    draws: render.drawCalls,
    shadowDraws: render.shadowDraws,
    quadsK: (render.visibleQuads / 1000).toFixed(1),
    chunksLit: world.lit,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

writeFileSync('scripts/perf.json', JSON.stringify({ gpu, results }, null, 2));
console.log('written: scripts/perf.json');

if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors.slice(0, 6)) console.log(e.slice(0, 800));
}

await browser.close();

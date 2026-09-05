/**
 * Two questions that decide the project's direction, answered with numbers
 * instead of opinion:
 *
 *  1. Is the CPU cost of a frame really driver overhead per draw call?
 *     Measured by scaling the render distance and watching whether CPU time in
 *     render() tracks the draw count.
 *
 *  2. Is WebGPU actually available on this GPU and driver? It would give
 *     compute shaders and render bundles without leaving the current stack, but
 *     only if Intel Gen9 D3D12 support holds up.
 *
 * Usage: node scripts/probe.mjs [url]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';

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
    // WebGPU probe
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
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

// --- question 2 first: it is instant and independent of the world ---
const webgpu = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return { available: false, reason: 'navigator.gpu отсутствует' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'requestAdapter вернул null' };
    const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const device = await adapter.requestDevice();
    return {
      available: true,
      vendor: info.vendor ?? '?',
      architecture: info.architecture ?? '?',
      description: info.description ?? '?',
      maxBindGroups: device.limits.maxBindGroups,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
      features: [...device.features].slice(0, 12),
    };
  } catch (error) {
    return { available: false, reason: String(error) };
  }
});

console.log('=== WebGPU ===');
console.log(JSON.stringify(webgpu, null, 2));

// --- question 1: does CPU time track draw count? ---
console.log('\n=== Draw call scaling ===');

await new Promise((r) => setTimeout(r, 25000));
await page.evaluate(() => {
  window.supergraph.setPreset('medium');
  window.supergraph.setTime(0.36);
  window.supergraph.findViewpoint(48);
  window.supergraph.enableGpuProfiler(true);
});
await new Promise((r) => setTimeout(r, 15000));

const rows = [];

for (const renderDistance of [3, 5, 7, 9]) {
  await page.evaluate((rd) => window.supergraph.setSetting('renderDistance', rd), renderDistance);
  // Streaming has to settle, or the numbers measure loading rather than drawing.
  await new Promise((r) => setTimeout(r, 20000));
  await page.evaluate(() => window.supergraph.resetFrameTimes());

  const start = Date.now();
  while (Date.now() - start < 10000) {
    await page.evaluate((t) => window.supergraph.look(t * 0.5, -0.08), (Date.now() - start) / 1000);
    await new Promise((r) => setTimeout(r, 120));
  }

  const sample = await page.evaluate(() => ({
    cpu: window.supergraph.cpuTimings(),
    gpu: window.supergraph.gpuTimings(),
    stats: window.supergraph.stats(),
    times: window.supergraph.frameTimes(),
  }));

  const gpuTotal = sample.gpu.reduce((a, b) => a + b.ms, 0);
  const mean = sample.times.reduce((a, b) => a + b, 0) / Math.max(sample.times.length, 1);

  const row = {
    rd: renderDistance,
    draws: sample.stats.render.drawCalls,
    shadowDraws: sample.stats.render.shadowDraws,
    quadsK: Math.round(sample.stats.render.visibleQuads / 1000),
    cpuRenderMs: Number(sample.cpu.render.toFixed(2)),
    gpuMs: Number(gpuTotal.toFixed(2)),
    frameMs: Number(mean.toFixed(2)),
    usPerDraw: Number(
      ((sample.cpu.render * 1000) /
        Math.max(sample.stats.render.drawCalls + sample.stats.render.shadowDraws, 1)).toFixed(1),
    ),
  };
  rows.push(row);
  console.log(
    `rd ${String(row.rd).padStart(2)}  draws ${String(row.draws).padStart(4)}` +
    ` (+${String(row.shadowDraws).padStart(4)} тени)  quads ${String(row.quadsK).padStart(4)}k` +
    `  CPU ${String(row.cpuRenderMs).padStart(6)} ms  GPU ${String(row.gpuMs).padStart(6)} ms` +
    `  кадр ${String(row.frameMs).padStart(6)} ms  ${String(row.usPerDraw).padStart(5)} мкс/draw`,
  );
}

writeFileSync('scripts/probe.json', JSON.stringify({ webgpu, rows }, null, 2));
await browser.close();

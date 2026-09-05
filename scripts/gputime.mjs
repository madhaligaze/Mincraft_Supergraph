/**
 * Per-pass GPU timings via EXT_disjoint_timer_query_webgl2.
 *
 * Usage: node scripts/gputime.mjs [url] [preset] [seconds]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PRESET = process.argv[3] ?? 'medium';
const SECONDS = Number(process.argv[4] ?? 20);

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
    // Timer queries are gated behind this in recent Chrome.
    '--enable-webgl-developer-extensions',
    '--disable-gpu-watchdog',
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

console.log(`GPU: ${await page.evaluate(() => window.supergraph.gpu)}`);

await new Promise((r) => setTimeout(r, 25000));
await page.evaluate((p) => {
  window.supergraph.setPreset(p);
  window.supergraph.setTime(0.36);
  window.supergraph.findViewpoint(48);
}, PRESET);
await new Promise((r) => setTimeout(r, 15000));

const supported = await page.evaluate(() => window.supergraph.enableGpuProfiler(true));
console.log(`timer queries: ${supported ? 'да' : 'НЕТ (расширение недоступно)'}`);
if (!supported) {
  await browser.close();
  process.exit(1);
}

await page.evaluate(() => window.supergraph.resetFrameTimes());

const start = Date.now();
while (Date.now() - start < SECONDS * 1000) {
  await page.evaluate((t) => window.supergraph.look(t * 0.4, -0.08), (Date.now() - start) / 1000);
  await new Promise((r) => setTimeout(r, 150));
}

const { timings, times, cpu } = await page.evaluate(() => ({
  timings: window.supergraph.gpuTimings(),
  times: window.supergraph.frameTimes(),
  cpu: window.supergraph.cpuTimings(),
}));

const mean = times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1);
console.log(`\npreset ${PRESET}: ${mean.toFixed(1)} ms/кадр (${(1000 / mean).toFixed(1)} fps)\n`);

let total = 0;
for (const t of timings) total += t.ms;

console.log('проход                 GPU ms     доля');
console.log('-------------------------------------');
for (const t of timings) {
  console.log(
    `${t.name.padEnd(20)} ${t.ms.toFixed(2).padStart(7)}  ${((t.ms / total) * 100).toFixed(0).padStart(6)}%`,
  );
}
console.log('-------------------------------------');
console.log(`${'сумма GPU'.padEnd(20)} ${total.toFixed(2).padStart(7)}`);

console.log('\nCPU (главный поток)     ms');
console.log('-------------------------------------');
let cpuTotal = 0;
for (const [name, ms] of Object.entries(cpu)) {
  cpuTotal += ms;
  console.log(`${name.padEnd(20)} ${ms.toFixed(2).padStart(7)}`);
}
console.log('-------------------------------------');
console.log(`${'сумма CPU'.padEnd(20)} ${cpuTotal.toFixed(2).padStart(7)}`);
console.log(`${'необъяснённое'.padEnd(20)} ${(mean - Math.max(total, cpuTotal)).toFixed(2).padStart(7)}`);

writeFileSync('scripts/gputime.json', JSON.stringify({ preset: PRESET, mean, timings }, null, 2));
await browser.close();

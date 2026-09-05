/**
 * Captures a set of representative frames at different times of day.
 *
 * Software rendering makes each frame take seconds, so the script waits for the
 * world to settle and for TAA to converge before every shot rather than
 * screenshotting blind.
 *
 * Usage: node scripts/gallery.mjs [url] [outDir]
 */

import { launch } from 'puppeteer-core';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT_DIR = process.argv[3] ?? 'scripts/gallery';
/** Optional substring filter, so a single shot can be re-taken quickly. */
const ONLY = process.argv[4] ?? '';

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

// `offset` is the camera azimuth relative to the sun: 0 looks into it,
// PI looks away with the light coming over the shoulder.
const SHOTS = [
  { name: '1-sunrise', time: 0.295, offset: 0.25, pitch: 0.03, rain: 0 },
  { name: '2-noon', time: 0.50, offset: 2.2, pitch: -0.10, rain: 0 },
  { name: '3-golden', time: 0.722, offset: 0.18, pitch: 0.02, rain: 0 },
  { name: '4-golden-side', time: 0.722, offset: 1.7, pitch: -0.05, rain: 0 },
  { name: '5-dusk', time: 0.765, offset: 0.1, pitch: 0.05, rain: 0 },
  { name: '6-night', time: 0.94, offset: 2.6, pitch: 0.06, rain: 0 },
  { name: '7-rain', time: 0.42, offset: 1.9, pitch: -0.04, rain: 0.9 },
  { name: '8-clouds', time: 0.46, offset: 1.2, pitch: 0.42, rain: 0 },
  { name: '9-clouds-golden', time: 0.735, offset: 0.5, pitch: 0.3, rain: 0 },
];

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,720',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.waitForFunction(
  () => {
    const play = document.getElementById('play');
    return play && !play.disabled;
  },
  { timeout: 240000, polling: 500 },
);

await page.evaluate(() => {
  document.getElementById('overlay')?.setAttribute('hidden', '');
});

// Let the world stream in around the spawn.
await new Promise((r) => setTimeout(r, 20000));

const settled = await page.evaluate(() => {
  const api = window.supergraph;
  // Stand on the highest loaded ground nearby: a viewpoint buried in a
  // hillside shows terraces and nothing else.
  const spot = api.findViewpoint(48) ?? { y: api.ground() };
  return { spot, stats: api.stats() };
});
console.log(`viewpoint=${JSON.stringify(settled.spot)} chunks=${JSON.stringify(settled.stats.world)}`);

// Let streaming catch up after the move.
await new Promise((r) => setTimeout(r, 10000));

for (const shot of SHOTS) {
  if (ONLY && !shot.name.includes(ONLY)) continue;

  await page.evaluate((s) => {
    const api = window.supergraph;
    api.setTime(s.time);
    api.faceSun(s.offset, s.pitch);
    api.setWeather(s.rain);
  }, shot);

  // Enough frames for streaming, the sky LUT and TAA to converge.
  await new Promise((r) => setTimeout(r, 14000));

  const file = join(OUT_DIR, `${shot.name}.png`);
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
}

if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors.slice(0, 8)) console.log(e.slice(0, 1200));
}

await browser.close();

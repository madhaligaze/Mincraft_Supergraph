/**
 * Dumps the chunk shader's debug channels from one fixed camera.
 *
 * Usage: node scripts/debugview.mjs <url> [outPrefix] [x y w h]
 *
 * The optional rectangle crops every channel to the same region, which is how
 * you compare an artefact across channels: a 40-pixel triangle is invisible in
 * a 1280x720 dump and obvious in a 300x200 one.
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [, , url, prefix = 'scripts/dbg', cx, cy, cw, ch] = process.argv;

const clip = cw !== undefined
  ? { x: Number(cx), y: Number(cy), width: Number(cw), height: Number(ch) }
  : undefined;

const VIEWS = [
  [0, 'shaded'], [1, 'vertexAO'], [2, 'skylight'],
  [4, 'normal'], [5, 'ssao'], [6, 'albedo'], [7, 'tint'],
  [8, 'bucket'], [10, 'height'], [11, 'indirect'], [12, 'gitrust'],
];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,720', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);
await page.evaluate(() => document.getElementById('overlay')?.setAttribute('hidden', ''));
await new Promise((r) => setTimeout(r, 22000));

await page.evaluate(() => {
  const api = window.supergraph;
  api.findViewpoint(48);
  api.setTime(0.5);
  api.faceSun(2.2, -0.22);
});
await new Promise((r) => setTimeout(r, 12000));

for (const [mode, name] of VIEWS) {
  await page.evaluate((m) => window.supergraph.setDebugView(m), mode);
  await new Promise((r) => setTimeout(r, 5000));
  const file = `${prefix}-${name}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png', clip }));
  console.log(`shot: ${file}`);
}

await browser.close();

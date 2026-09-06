/**
 * Close-up A/B screenshot, for effects that only exist near the camera.
 *
 * `diag.mjs` frames a landscape, which is the wrong shot for parallax, wetness
 * or texture work: those live in the first few blocks in front of the player.
 * This one looks down at the ground at a grazing angle instead, which is where
 * relief reads strongest.
 *
 * Usage: node scripts/closeup.mjs <url> <settingKey> <valueA> <valueB> [prefix] [pitch] [rain]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [, , url, key, valueA, valueB, prefix = 'scripts/closeup', pitch = '-0.55', rain = '0'] = process.argv;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const parse = (v) => (v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v));

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

// A low sun rakes across the relief; overhead light flattens it.
await page.evaluate((p, r) => {
  const api = window.supergraph;
  api.findViewpoint(48);
  api.setTime(0.29);
  api.faceSun(1.9, p);
  if (r > 0) api.setWeather(r);
}, Number(pitch), Number(rain));
await new Promise((r) => setTimeout(r, 12000));

for (const value of [valueA, valueB]) {
  await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, parse(value));
  await new Promise((r) => setTimeout(r, 14000));
  const file = `${prefix}-${key}-${value}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
}

await browser.close();

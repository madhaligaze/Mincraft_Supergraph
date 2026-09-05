/**
 * One-off A/B screenshot at a fixed camera, toggling a single setting.
 *
 * Usage: node scripts/diag.mjs <url> <settingKey> <valueA> <valueB> <outPrefix>
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [, , url, key, valueA, valueB, prefix = 'scripts/diag'] = process.argv;

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

await page.evaluate(() => {
  const api = window.supergraph;
  api.findViewpoint(48);
  api.setTime(0.5);
  api.faceSun(2.2, -0.12);
});
await new Promise((r) => setTimeout(r, 12000));

for (const value of [valueA, valueB]) {
  await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, parse(value));
  await new Promise((r) => setTimeout(r, 14000));
  const file = `${prefix}-${key}-${value}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
}

await browser.close();

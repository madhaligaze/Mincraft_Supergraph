/**
 * Generic page screenshotter, for the debug pages that are not the game.
 *
 * Usage: node scripts/shoot.mjs <url> <out.png> [width] [height] [waitMs]
 */

import { launch } from 'puppeteer-core';
import { writeFileSync, existsSync } from 'node:fs';

const [, , url, out, w = '1400', h = '1000', wait = '2500'] = process.argv;
if (!url || !out) {
  console.error('usage: node scripts/shoot.mjs <url> <out.png> [w] [h] [waitMs]');
  process.exit(2);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h) });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, Number(wait)));

writeFileSync(out, await page.screenshot({ type: 'png', fullPage: true }));
console.log(`screenshot: ${out}`);
if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors.slice(0, 8)) console.log(e.slice(0, 1500));
}

await browser.close();

/**
 * Shows a pack's albedo tiles at 2x2, the way `materials.html` does for the
 * procedural set: what a material looks like on its own, and whether it tiles.
 *
 * Usage: node scripts/packalbedo.mjs snow grass_top sand [out.png]
 */

import { launch } from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const args = process.argv.slice(2);
const out = args.at(-1)?.endsWith('.png') ? args.pop() : 'scripts/packalbedo.png';
const names = args.length > 0 ? args : ['snow', 'grass_top', 'sand', 'stone'];

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const urls = names.map((n) => {
  const path = `public/pack/${n}.png`;
  return existsSync(path)
    ? `data:image/png;base64,${readFileSync(path).toString('base64')}`
    : null;
});

const base64 = await page.evaluate(async (list, labels) => {
  const TILE = 256;
  const canvas = new OffscreenCanvas(TILE * list.length, TILE + 18);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  for (let k = 0; k < list.length; k++) {
    if (!list[k]) continue;
    const bitmap = await createImageBitmap(await (await fetch(list[k])).blob());
    const size = Math.min(bitmap.width, bitmap.height);
    // Two by two, so a seam at the tile edge shows up as a seam.
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        ctx.drawImage(
          bitmap, 0, 0, size, size,
          k * TILE + tx * TILE / 2, 18 + ty * TILE / 2, TILE / 2, TILE / 2,
        );
      }
    }
    bitmap.close();
    ctx.fillStyle = '#d8d8e0';
    ctx.font = '13px monospace';
    ctx.fillText(`${labels[k]}  ${size}px`, k * TILE + 4, 13);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const b of buffer) binary += String.fromCharCode(b);
  return btoa(binary);
}, urls, names);

writeFileSync(out, Buffer.from(base64, 'base64'));
console.log(`albedo: ${out}`);
await browser.close();

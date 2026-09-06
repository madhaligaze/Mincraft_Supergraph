/**
 * Crops a rectangle out of a screenshot and magnifies it, nearest-neighbour.
 *
 * An artefact forty pixels across is invisible on a 1280x720 contact sheet, and
 * re-shooting the scene with a narrow field of view moves the camera, which
 * changes the artefact. Cutting it out of the frame that already has it does
 * not.
 *
 * Usage: node scripts/crop.mjs <in.png> <out.png> <x> <y> <w> <h> [zoom]
 */

import { launch } from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , input, out, x, y, w, h, zoom = '4'] = process.argv;
if (!input || !out || w === undefined) {
  console.error('usage: node scripts/crop.mjs <in.png> <out.png> <x> <y> <w> <h> [zoom]');
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
await page.goto('about:blank');

const url = `data:image/png;base64,${readFileSync(input).toString('base64')}`;

const base64 = await page.evaluate(async (src, rect) => {
  const bitmap = await createImageBitmap(await (await fetch(src)).blob());
  const canvas = new OffscreenCanvas(rect.w * rect.zoom, rect.h * rect.zoom);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    bitmap, rect.x, rect.y, rect.w, rect.h,
    0, 0, rect.w * rect.zoom, rect.h * rect.zoom,
  );
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const b of buffer) binary += String.fromCharCode(b);
  return btoa(binary);
}, url, { x: Number(x), y: Number(y), w: Number(w), h: Number(h), zoom: Number(zoom) });

writeFileSync(out, Buffer.from(base64, 'base64'));
console.log(`crop: ${out}`);
await browser.close();

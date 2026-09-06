/**
 * Dumps a pack's height field as an image, stretched the way packLoader does.
 *
 * The numbers say the field has ten levels; they do not say what shape those
 * levels draw. Whether the relief is one dome per block or one bead per texel
 * decides whether parallax should be tamed or switched off, and the only way to
 * see it is to look at it.
 *
 * Usage: node scripts/packheight.mjs snow grass_top sand [out.png]
 */

import { launch } from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const args = process.argv.slice(2);
const out = args.at(-1)?.endsWith('.png') ? args.pop() : 'scripts/packheight.png';
const names = args.length > 0 ? args : ['grass_top', 'snow', 'sand', 'stone'];

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const urls = names.map((n) => {
  const path = `public/pack/${n}_n.png`;
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

  for (let k = 0; k < list.length; k++) {
    if (!list[k]) continue;
    const bitmap = await createImageBitmap(
      await (await fetch(list[k])).blob(),
      { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
    );
    const size = Math.min(bitmap.width, bitmap.height);
    const src = new OffscreenCanvas(size, size);
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const image = sctx.getImageData(0, 0, size, size);
    let min = 255, max = 0;
    for (let i = 3; i < image.data.length; i += 4) {
      const v = image.data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = Math.max(1, max - min);

    const view = sctx.createImageData(size, size);
    for (let p = 0; p < size * size; p++) {
      const v = Math.round(((image.data[p * 4 + 3] - min) / span) * 255);
      view.data[p * 4] = v;
      view.data[p * 4 + 1] = v;
      view.data[p * 4 + 2] = v;
      view.data[p * 4 + 3] = 255;
    }
    sctx.putImageData(view, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, size, size, k * TILE, 18, TILE, TILE);
    ctx.fillStyle = '#d8d8e0';
    ctx.font = '13px monospace';
    ctx.fillText(`${labels[k]}  ${min}..${max}`, k * TILE + 4, 13);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const b of buffer) binary += String.fromCharCode(b);
  return btoa(binary);
}, urls, names);

writeFileSync(out, Buffer.from(base64, 'base64'));
console.log(`height fields: ${out}`);
await browser.close();

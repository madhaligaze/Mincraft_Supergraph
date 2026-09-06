/**
 * Prints the mean colour of a rectangle in a screenshot.
 *
 * "Looks the same" is not a measurement, and two screenshots taken minutes
 * apart under an auto-exposing camera are exactly the case where the eye is
 * least reliable.
 *
 * Usage: node scripts/pixel.mjs <x> <y> <w> <h> <file...>
 */
import { launch } from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const [, , x, y, w, h, ...files] = process.argv;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const browser = await launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.goto('about:blank');

for (const file of files) {
  const url = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  const mean = await page.evaluate(async (src, r) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = new OffscreenCanvas(r.w, r.h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    bitmap.close();
    const data = ctx.getImageData(0, 0, r.w, r.h).data;
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < data.length; i += 4) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; }
    const n = data.length / 4;
    return [sr / n, sg / n, sb / n];
  }, url, { x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
  console.log(`${file.padEnd(28)} ${mean.map((v) => v.toFixed(1).padStart(6)).join(' ')}`);
}

await browser.close();

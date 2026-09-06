/**
 * What a resource pack actually contains, channel by channel.
 *
 * `normalizeHeight` in packLoader.ts stretches a compressed height field to the
 * full range, and the gain it picks decides how deep the parallax relief comes
 * out. That gain is derived from numbers nobody has ever looked at. This prints
 * them: the span of the height field, the gain the loader would apply, how many
 * distinct levels survive the stretch (a field with ten levels stretched
 * twenty-four times is a staircase, not relief), and the smoothness the pack
 * asks for.
 *
 * Usage: node scripts/packstats.mjs [material ...]
 */

import { launch } from 'puppeteer-core';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const PACK = 'public/pack';

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : readdirSync(PACK)
  .filter((f) => f.endsWith('_n.png'))
  .map((f) => f.slice(0, -6));

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const dataUrl = (file) => {
  const path = `${PACK}/${file}`;
  if (!existsSync(path)) return null;
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
};

const rows = [];
for (const name of names) {
  const normal = dataUrl(`${name}_n.png`);
  const specular = dataUrl(`${name}_s.png`);
  if (!normal) continue;

  const stats = await page.evaluate(async (n, s) => {
    const read = async (url) => {
      if (!url) return null;
      const bitmap = await createImageBitmap(
        await (await fetch(url)).blob(),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
      );
      const size = Math.min(bitmap.width, bitmap.height);
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, size, size, 0, 0, size, size);
      bitmap.close();
      return { data: ctx.getImageData(0, 0, size, size).data, size };
    };

    const channel = (image, offset) => {
      const seen = new Set();
      let min = 255, max = 0, sum = 0;
      for (let i = offset; i < image.data.length; i += 4) {
        const v = image.data[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        seen.add(v);
      }
      return { min, max, levels: seen.size, mean: sum / (image.data.length / 4) };
    };

    const normalImage = await read(n);
    const specularImage = await read(s);
    return {
      size: normalImage.size,
      height: channel(normalImage, 3),
      smoothness: specularImage ? channel(specularImage, 0) : null,
    };
  }, normal, specular);

  const span = stats.height.max - stats.height.min;
  const gain = span < 4 ? 0 : Math.min(255 / span, 24);
  rows.push({ name, ...stats, span, gain });
}

rows.sort((a, b) => b.gain - a.gain);

console.log('material            size  height min..max  span  gain  levels  smoothness mean/max');
for (const r of rows) {
  const sm = r.smoothness
    ? `${r.smoothness.mean.toFixed(0)}/${r.smoothness.max}`
    : '-';
  console.log(
    `${r.name.padEnd(20)}${String(r.size).padStart(4)}` +
    `${String(r.height.min).padStart(8)}..${String(r.height.max).padEnd(4)}` +
    `${String(r.span).padStart(6)}${r.gain.toFixed(1).padStart(6)}` +
    `${String(r.height.levels).padStart(8)}  ${sm}`,
  );
}

await browser.close();

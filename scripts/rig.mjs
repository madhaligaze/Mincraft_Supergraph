/**
 * Test rig: builds a floor and a wall in front of the camera, then A/B shoots
 * one setting.
 *
 * Terrain almost never puts the case an effect needs right in front of the
 * player: parallax wants a strong-relief material at a grazing angle, indirect
 * light wants a pale wall over a strongly coloured floor, wet reflections want
 * something standing next to the puddle. So the rig builds it.
 *
 * Usage:
 *   node scripts/rig.mjs <url> <setting> <a> <b> [prefix] [floor] [wall] [rain] [pitch]
 *
 * Blocks are ids from world/blocks.ts: 1 stone, 8 red sand, 12 snow, 16 cobble.
 *
 * Examples:
 *   node scripts/rig.mjs URL giStrength 0 1.5 scripts/gi 8 12
 *   node scripts/rig.mjs URL wetReflections false true scripts/wet 1 12 1 -0.35
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [
  , , url, key, valueA, valueB,
  prefix = 'scripts/rig',
  floorBlock = '8', wallBlock = '12', rain = '0', pitch = '-0.1',
] = process.argv;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const parse = (v) => (v === 'true' ? true : v === 'false' ? false : Number(v));

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

const spot = await page.evaluate((r) => {
  const api = window.supergraph;
  api.findViewpoint(48);
  const y = api.ground();
  api.setTime(0.5);
  if (r > 0) api.setWeather(r);
  return { x: Math.floor(api.player.position[0]), y, z: Math.floor(api.player.position[2]) };
}, Number(rain));

// One edit per tick: an edit drops its column back to "needs relighting", and a
// second edit in the same frame is refused until that finishes.
const place = async (x, y, z, block) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ok = await page.evaluate(
      (px, py, pz, b) => window.supergraph.world.setBlock(px, py, pz, b),
      x, y, z, block,
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

let placed = 0;
for (let dz = -5; dz <= 1; dz++) {
  for (let dx = -3; dx <= 3; dx++) {
    if (await place(spot.x + dx, spot.y - 1, spot.z + dz, Number(floorBlock))) placed++;
  }
}
for (let dy = 0; dy < 3; dy++) {
  for (let dx = -3; dx <= 3; dx++) {
    if (await place(spot.x + dx, spot.y + dy, spot.z - 6, Number(wallBlock))) placed++;
  }
}
console.log(`rig at ${spot.x} ${spot.y} ${spot.z}, blocks placed: ${placed}`);

await page.evaluate((x, y, z, p, r) => {
  window.supergraph.teleport(x + 0.5, y + 0.05, z + 0.5);
  window.supergraph.look(0, p);
  if (r > 0) window.supergraph.setWeather(r);
}, spot.x, spot.y, spot.z, Number(pitch), Number(rain));
await new Promise((r) => setTimeout(r, 14000));

for (const value of [valueA, valueB]) {
  await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, parse(value));
  await new Promise((r) => setTimeout(r, 12000));
  const file = `${prefix}-${key}-${value}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
}

await browser.close();

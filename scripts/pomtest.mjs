/**
 * Parallax rig: builds a test wall in front of the camera and shoots it.
 *
 * Terrain rarely puts a strong-relief material right in front of the player at
 * a grazing angle, which is exactly the case parallax has to be judged on. So
 * this places one: a slab of cobblestone two blocks away, lit by a low sun.
 *
 * Usage: node scripts/pomtest.mjs <url> [prefix]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [, , url, prefix = 'scripts/pomwall'] = process.argv;

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

const spot = await page.evaluate(() => {
  const api = window.supergraph;
  api.findViewpoint(48);
  const y = api.ground();
  api.setTime(0.28);
  return { x: Math.floor(api.player.position[0]), y, z: Math.floor(api.player.position[2]) };
});

// One edit per tick: an edit drops its column back to "needs relighting", so a
// second edit in the same frame is refused until that finishes.
const COBBLE = 16;
let placed = 0;
for (let dy = 3; dy >= 0; dy--) {
  for (let dx = -3; dx <= 3; dx++) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await page.evaluate(
        (x, y, z, b) => window.supergraph.world.setBlock(x, y, z, b),
        spot.x + dx, spot.y + dy, spot.z - 5, COBBLE,
      );
      if (ok) { placed++; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
console.log(`wall at ${spot.x} ${spot.y} ${spot.z}, blocks placed: ${placed}`);

// Stand close enough that the wall is inside the parallax range and the ground
// in front of it runs away from the eye at a grazing angle.
await page.evaluate((x, y, z) => {
  window.supergraph.teleport(x + 0.5, y + 0.05, z - 2.0);
  window.supergraph.look(0, -0.16);
}, spot.x, spot.y, spot.z);
await new Promise((r) => setTimeout(r, 12000));

const shots = [
  { name: 'off', settings: { parallaxEnabled: false } },
  { name: 'on', settings: { parallaxEnabled: true, parallaxDepth: 0.09, parallaxShadows: false } },
  { name: 'selfshadow', settings: { parallaxEnabled: true, parallaxDepth: 0.09, parallaxShadows: true } },
];

for (const shot of shots) {
  for (const [key, value] of Object.entries(shot.settings)) {
    await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, value);
  }
  await new Promise((r) => setTimeout(r, 12000));
  const file = `${prefix}-${shot.name}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
}

await browser.close();

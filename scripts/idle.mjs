/**
 * Is the camera still when the player is?
 *
 * "It shakes when I stand still" is a claim about numbers, and the numbers are
 * right there in the debug handle. This records the camera basis every frame
 * for a few seconds with no input at all and prints the peak-to-peak range of
 * each component, plus the terms that feed it — so a wobble can be attributed
 * to the walk bob, to the collision resolver, or to neither, in one run.
 *
 * A block is a metre. Anything under a millimetre of travel is not what a
 * player means by shaking; anything over a centimetre is.
 *
 * Usage: node scripts/idle.mjs [url] [seconds]
 */

import { launch } from 'puppeteer-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';
const seconds = Number(process.argv[3] ?? 4);

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

// The frame loop only integrates while `running`, which the Play button sets.
// Standing still has to be measured in the state the player is actually in.
await page.click('#play');
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate(() => {
  const api = window.supergraph;
  api.setTime(0.42);
  api.findViewpoint(48);
  api.ground();
  api.player.flying = false;
});
await new Promise((r) => setTimeout(r, 14000));

// Let the fall settle and the damped terms decay before recording.
await page.evaluate(() => window.supergraph.ground());
await new Promise((r) => setTimeout(r, 3000));

const samples = await page.evaluate((duration) => new Promise((resolve) => {
  const api = window.supergraph;
  const rows = [];
  const start = performance.now();

  const step = () => {
    const p = api.player;
    rows.push([
      p.camera.position[0], p.camera.position[1], p.camera.position[2],
      p.camera.forward[0], p.camera.forward[1], p.camera.forward[2],
      p.camera.up[0], p.camera.up[2],
      p.position[1],
      p.velocity[0], p.velocity[1], p.velocity[2],
      p.onGround ? 1 : 0,
    ]);
    if (performance.now() - start < duration * 1000) requestAnimationFrame(step);
    else resolve(rows);
  };
  requestAnimationFrame(step);
}), seconds);

const NAMES = [
  'camera.x', 'camera.y', 'camera.z',
  'forward.x', 'forward.y', 'forward.z',
  'up.x', 'up.z',
  'feet.y',
  'vel.x', 'vel.y', 'vel.z',
  'onGround',
];

console.log(`кадров: ${samples.length}`);
console.log('величина            мин            макс        размах');
console.log('-----------------------------------------------------');
for (let i = 0; i < NAMES.length; i++) {
  let min = Infinity;
  let max = -Infinity;
  for (const row of samples) {
    if (row[i] < min) min = row[i];
    if (row[i] > max) max = row[i];
  }
  const span = max - min;
  const flag = i < 8 && span > 0.001 ? '  <-- дрожит' : '';
  console.log(
    `${NAMES[i].padEnd(12)}${min.toFixed(6).padStart(14)}${max.toFixed(6).padStart(14)}` +
    `${span.toExponential(2).padStart(12)}${flag}`,
  );
}

await browser.close();

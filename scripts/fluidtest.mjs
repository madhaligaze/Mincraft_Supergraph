/**
 * Does water actually flow?
 *
 * Four cases, each one a thing a player does in the first ten minutes:
 *
 *   1. Dig a hole in the sea floor. It must fill, and stay filled — that is
 *      the two-adjacent-sources rule, and without it the ocean would drain
 *      into every hole ever dug.
 *   2. Place a source on flat ground. It must spread outward and stop at the
 *      fluid's range rather than covering the world.
 *   3. Break the source. Everything it fed must dry out.
 *   4. Pour a source over a ledge. It must fall rather than spread, and reach
 *      the bottom.
 *
 * Written as a test and not as a screenshot because none of these are about
 * how it looks. A screenshot of standing water and a screenshot of water that
 * cannot move are the same screenshot.
 *
 * Usage: node scripts/fluidtest.mjs [url]
 */

import { launch } from 'puppeteer-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';
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
// The fluid clock only advances while the game is running, and clicking the
// button is not enough: headless Chrome refuses pointer lock, the game sees
// that as the player alt-tabbing away, and pauses again immediately.
await page.evaluate(() => window.supergraph.play());
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  const api = window.supergraph;
  api.setTime(0.4);
  api.findViewpoint(48);
  api.player.flying = true;
});
await new Promise((r) => setTimeout(r, 18000));

/**
 * Runs the simulation until it settles.
 *
 * Ticks it directly rather than waiting on wall-clock time: the simulation is
 * frame-paced and a headless browser on software rendering manages a few frames
 * a second, so waiting would mean a minute per case and a test written to be
 * lenient instead of correct.
 */
const settle = async (ticks = 200) => {
  for (let i = 0; i < ticks; i += 10) {
    const pending = await page.evaluate((n) => window.supergraph.tickFluids(n), 10);
    if (pending === 0) return 0;
  }
  return page.evaluate(() => window.supergraph.world.fluids.pending);
};

/** One edit per tick: an edit drops its column back to "needs relighting". */
const place = async (x, y, z, block) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ok = await page.evaluate(
      (px, py, pz, b) => window.supergraph.world.setBlock(px, py, pz, b),
      x, y, z, block,
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const blockAt = (x, y, z) => page.evaluate(
  (px, py, pz) => {
    const api = window.supergraph;
    const b = api.world.getBlock(px, py, pz);
    return { id: b, name: api.blockName(b), water: api.isWater(b) };
  }, x, y, z,
);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- 1. a hole in the sea floor ---
const sea = await page.evaluate(() => {
  const { world, player } = window.supergraph;
  const cx = Math.floor(player.position[0]);
  const cz = Math.floor(player.position[2]);
  const SEA = 62;
  for (let i = 0; i < 6000; i++) {
    const a = i * 2.399963;
    const d = Math.sqrt(i / 6000) * 200;
    const x = cx + Math.round(Math.cos(a) * d);
    const z = cz + Math.round(Math.sin(a) * d);
    if (!world.isReadyAt(x, z)) continue;
    // Water from the surface down to a floor with solid ground under it.
    if (!window.supergraph.isWater(world.getBlock(x, SEA - 1, z))) continue;
    if (!window.supergraph.isWater(world.getBlock(x, SEA - 4, z))) continue;
    for (let y = SEA - 5; y > SEA - 14; y--) {
      if (window.supergraph.isWater(world.getBlock(x, y, z))) continue;
      if (world.getBlock(x, y, z) === 0) break;
      if (world.getBlock(x, y - 1, z) === 0) break;
      return { x, y, z };
    }
  }
  return null;
});
console.log(`дно моря: ${sea ? `${sea.x} ${sea.y} ${sea.z}` : 'не найдено'}`);

if (sea) {
  await place(sea.x, sea.y, sea.z, 0);          // dig one block of sea floor
  const pending = await settle();
  const filled = await blockAt(sea.x, sea.y, sea.z);
  check(
    'яма в дне моря заполняется',
    filled.water,
    `${filled.name}, очередь ${pending}`,
  );

  // Deeper: two blocks down, the hole must fill all the way.
  await place(sea.x, sea.y - 1, sea.z, 0);
  await settle();
  const deep = await blockAt(sea.x, sea.y - 1, sea.z);
  check('яма в два блока заполняется до дна', deep.water, deep.name);
}

// --- 2, 3, 4. a flat patch built on purpose ---
const spot = await page.evaluate(() => {
  const api = window.supergraph;
  const y = api.ground();
  return { x: Math.floor(api.player.position[0]), y, z: Math.floor(api.player.position[2]) };
});
console.log(`площадка: ${spot.x} ${spot.y} ${spot.z}`);

// A stone floor with clear air over it, so the spread is not swallowed by
// terrain. One batched fill rather than a retry loop per block.
await page.evaluate((s) => {
  const w = window.supergraph.world;
  w.fillBlocks(s.x - 9, s.y, s.z - 9, s.x + 9, s.y, s.z + 9, 1);
  w.fillBlocks(s.x - 9, s.y + 1, s.z - 9, s.x + 9, s.y + 3, s.z + 9, 0);
}, spot);
await settle();

await place(spot.x, spot.y + 1, spot.z, 31);    // water source
const pendingSpread = await settle(400);

const reach = await page.evaluate((s) => {
  const api = window.supergraph;
  let far = 0;
  for (let d = 1; d <= 9; d++) {
    if (api.isWater(api.world.getBlock(s.x + d, s.y + 1, s.z))) far = d;
  }
  return far;
}, spot);
check('источник растекается', reach >= 5 && reach <= 7, `дошло до ${reach} блоков, очередь ${pendingSpread}`);

await place(spot.x, spot.y + 1, spot.z, 0);     // remove the source
await settle(600);
const dried = await page.evaluate((s) => {
  const api = window.supergraph;
  let left = 0;
  for (let dz = -7; dz <= 7; dz++) {
    for (let dx = -7; dx <= 7; dx++) {
      if (api.isWater(api.world.getBlock(s.x + dx, s.y + 1, s.z + dz))) left++;
    }
  }
  return left;
}, spot);
check('после снятия источника течение высыхает', dried === 0, `осталось клеток: ${dried}`);

// --- 4. falling ---
await page.evaluate((s) => {
  window.supergraph.world.fillBlocks(s.x + 3, s.y - 3, s.z, s.x + 3, s.y, s.z, 0);
}, spot);
await settle();
await place(spot.x, spot.y + 1, spot.z, 31);
await settle(400);
const bottom = await blockAt(spot.x + 3, spot.y - 3, spot.z);
check('вода льётся в шахту', bottom.water, bottom.name);

console.log('');
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? 'жидкости работают' : `${failed} проверок не прошло`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);

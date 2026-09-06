/**
 * Contact sheet of the six places the world was reported to look wrong.
 *
 * Screenshots of a running world are the only honest test for this kind of
 * work — types do not see a whited-out horizon and the smoke test does not care
 * that water is black. Every other diagnostic script here shoots one thing;
 * this one shoots the whole complaint list at fixed camera positions so two
 * runs are comparable frame by frame.
 *
 * The scenes, and what each is for:
 *
 *   sun     looking into the sun across terrain     — glare, burnt horizon
 *   ground  grazing look at the surface underfoot   — parallax, gloss
 *   blocks  straight down at a block boundary       — relief, sliced edges
 *   sea     shoreline out to open water             — wave shape, water colour
 *   under   submerged, looking level                — underwater look
 *   tree    a whole tree from fifteen blocks        — silhouette, trunk to crown
 *   canopy  under the same tree, looking up         — leaf density and light
 *   air     high above, looking down                — draw distance, depth
 *
 * Any argument of the form `key=value` is applied as a setting override before
 * the first shot, which is what makes this an A/B rig and not just a gallery:
 * two runs with different prefixes and one override isolate exactly one cause.
 *
 * Usage: node scripts/scenes.mjs <url> [prefix] [scene ...] [key=value ...]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const [, , url, prefix = 'scripts/scene', ...rest] = process.argv;
if (!url) {
  console.error('usage: node scripts/scenes.mjs <url> [prefix] [scene ...] [key=value ...]');
  process.exit(2);
}

const only = rest.filter((a) => !a.includes('='));
const overrides = rest.filter((a) => a.includes('=')).map((a) => {
  const [key, raw] = a.split('=');
  const value = raw === 'true' ? true : raw === 'false' ? false
    : Number.isNaN(Number(raw)) ? raw : Number(raw);
  return { key, value };
});

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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
await new Promise((r) => setTimeout(r, 20000));

/**
 * Stands on a scenic rise and freezes the clock; every scene starts here.
 *
 * Flight stays on for the whole run. Half of these scenes put the camera where
 * gravity would not leave it — ninety blocks up, or three blocks under the
 * sea — and a falling camera makes the shot depend on how long the chunks took
 * to stream in.
 */
const home = await page.evaluate(() => {
  const api = window.supergraph;
  api.setTime(0.42);
  const spot = api.findViewpoint(48);
  api.player.flying = true;
  return spot;
});
console.log(`home: ${home ? `${home.x} ${home.y} ${home.z}` : 'not found'}`);

for (const { key, value } of overrides) {
  // `debug=N` is not a setting; it is the shader's output-channel selector, and
  // it is the fastest way to tell an artefact in the texture from one in the
  // lighting without rebuilding anything.
  if (key === 'debug') {
    await page.evaluate((v) => window.supergraph.setDebugView(v), value);
  } else {
    await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, value);
  }
  console.log(`set: ${key} = ${value}`);
}

await new Promise((r) => setTimeout(r, 14000));

/**
 * Spiral search around the player for a column matching a predicate, evaluated
 * in the page. Returns the first hit, which is also the nearest.
 */
const findColumn = (kind, radius) => page.evaluate((k, r) => {
  const api = window.supergraph;
  const { world, player } = api;
  const cx = Math.floor(player.position[0]);
  const cz = Math.floor(player.position[2]);
  const SEA = 62;
  // Block ids from the enum in world/blocks.ts, counted from Air = 0.
  const WATER = 31;
  const LOGS = [18, 20, 22];   // oak, birch, spruce

  for (let i = 0; i < 6000; i++) {
    const a = i * 2.399963;
    const d = Math.sqrt(i / 6000) * r;
    const x = cx + Math.round(Math.cos(a) * d);
    const z = cz + Math.round(Math.sin(a) * d);
    if (!world.isReadyAt(x, z)) continue;
    const h = world.store.getHeight(x, z);
    if (h < 0) continue;

    if (k === 'shore') {
      // Dry land within a block or two of sea level, with real water in front.
      if (h < SEA + 1 || h > SEA + 3) continue;
      let water = 0;
      for (let s = 4; s <= 24; s += 4) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (world.getBlock(x + dx * s, SEA, z + dz * s) === WATER) water++;
        }
      }
      if (water < 12) continue;
      return { x, y: h + 1, z };
    }

    if (k === 'deep') {
      // Six blocks of water over the bottom, asked of the blocks themselves:
      // the height map's idea of "the top" is not reliably the sea floor.
      if (world.getBlock(x, SEA - 2, z) !== WATER) continue;
      if (world.getBlock(x, SEA - 6, z) !== WATER) continue;
      return { x, y: SEA - 4, z };
    }

    if (k === 'tree') {
      // A trunk: four or more log blocks stacked anywhere in the column. The y
      // returned is the *foot* of the trunk, not the column height — the height
      // map counts the canopy, and standing on top of that looks down at the
      // treetops rather than up at a tree.
      let logs = 0;
      let foot = -1;
      for (let y = SEA; y < 140; y++) {
        if (!LOGS.includes(world.getBlock(x, y, z))) continue;
        logs++;
        if (foot < 0) foot = y;
      }
      if (logs < 4) continue;
      return { x, y: foot, z };
    }
  }
  return null;
}, kind, radius);

const shoot = async (name, setup, settle = 11000) => {
  if (only.length > 0 && !only.includes(name)) return;
  const ok = await page.evaluate(setup);
  if (ok === false) {
    console.log(`skip: ${name} (nothing to point at)`);
    return;
  }
  await new Promise((r) => setTimeout(r, settle));
  const file = `${prefix}-${name}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log(`shot: ${file}`);
};

const home3 = home ?? { x: 0, y: 70, z: 0 };

// --- 1. into the sun ---
await shoot('sun', `(() => {
  const api = window.supergraph;
  api.teleport(${home3.x} + 0.5, ${home3.y} + 1.7, ${home3.z} + 0.5);
  api.faceSun(0.16, 0.03);
  return true;
})()`);

// --- 2. the surface underfoot, at a grazing angle ---
await shoot('ground', `(() => {
  const api = window.supergraph;
  api.teleport(${home3.x} + 0.5, ${home3.y} + 1.7, ${home3.z} + 0.5);
  api.faceSun(1.9, -0.62);
  return true;
})()`);

// --- 3. straight down at a block boundary ---
await shoot('blocks', `(() => {
  const api = window.supergraph;
  api.teleport(${home3.x} + 0.5, ${home3.y} + 1.7, ${home3.z} + 0.5);
  api.faceSun(2.4, -1.15);
  return true;
})()`);

// --- 4. a whole tree, and the same tree from underneath ---
// Searched from home, before anything walks off to the coast: the forest is
// here, and `isReadyAt` only answers for chunks that are currently streamed in.
//
// Two shots, because they answer different questions. The portrait shows the
// silhouette and, more to the point, whether the trunk actually reaches the
// crown — a canopy standing off the top of its own trunk is the single most
// obvious thing that can be wrong with a tree, and it is invisible from below.
const tree = await findColumn('tree', 190);
console.log(`tree: ${tree ? `${tree.x} ${tree.y} ${tree.z}` : 'not found'}`);
if (tree) {
  await page.evaluate((t) => window.supergraph.teleport(t.x + 15.5, t.y + 6, t.z + 0.5), tree);
  await new Promise((r) => setTimeout(r, 14000));
  await shoot('tree', `(() => {
    const api = window.supergraph;
    api.teleport(${tree.x} + 15.5, ${tree.y} + 6, ${tree.z} + 0.5);
    api.look(Math.PI * 0.5, 0.12);
    return true;
  })()`);
  await shoot('canopy', `(() => {
    const api = window.supergraph;
    api.teleport(${tree.x} + 4.5, ${tree.y} + 2.2, ${tree.z} + 0.5);
    api.look(Math.PI * 0.5, 0.5);
    return true;
  })()`);
  await page.evaluate((h) => window.supergraph.teleport(h.x + 0.5, h.y + 1.7, h.z + 0.5), home3);
  await new Promise((r) => setTimeout(r, 10000));
}

const shore = await findColumn('shore', 200);
console.log(`shore: ${shore ? `${shore.x} ${shore.y} ${shore.z}` : 'not found'}`);
if (shore) {
  await page.evaluate((s) => window.supergraph.teleport(s.x + 0.5, s.y + 1.7, s.z + 0.5), shore);
  await new Promise((r) => setTimeout(r, 14000));
  await shoot('sea', `(() => {
    const api = window.supergraph;
    api.teleport(${shore.x} + 0.5, ${shore.y} + 1.7, ${shore.z} + 0.5);
    api.faceSun(2.1, -0.12);
    return true;
  })()`);
}

const deep = await findColumn('deep', 220);
console.log(`deep: ${deep ? `${deep.x} ${deep.y} ${deep.z}` : 'not found'}`);
if (deep) {
  await page.evaluate((d) => window.supergraph.teleport(d.x + 0.5, d.y, d.z + 0.5), deep);
  await new Promise((r) => setTimeout(r, 14000));
  await shoot('under', `(() => {
    const api = window.supergraph;
    api.teleport(${deep.x} + 0.5, ${deep.y}, ${deep.z} + 0.5);
    api.faceSun(1.2, -0.05);
    return true;
  })()`);
}

// --- 7. bird's eye ---
await page.evaluate((h) => window.supergraph.teleport(h.x + 0.5, h.y + 95, h.z + 0.5), home3);
await new Promise((r) => setTimeout(r, 16000));
await shoot('air', `(() => {
  const api = window.supergraph;
  api.teleport(${home3.x} + 0.5, ${home3.y} + 95, ${home3.z} + 0.5);
  api.faceSun(2.2, -0.34);
  return true;
})()`, 16000);

await browser.close();

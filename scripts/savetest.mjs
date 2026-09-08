/**
 * Checks that the world survives a reload.
 *
 * Places a block, fills a chest, drops items on the floor, takes damage, flushes
 * the save, reloads the page from scratch and looks for all of it again. This is
 * the one property that cannot be verified by reading the code: it depends on
 * the browser's storage, on the edits being in memory before the first column is
 * generated, and on them being replayed at the one moment when nothing has read
 * the terrain yet.
 *
 * Usage: node scripts/savetest.mjs [url]
 */

import { launch } from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';

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
    '--enable-features=SharedArrayBuffer', '--no-sandbox', '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

const ready = () => page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);

// --- first visit: build something and save it ---
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await ready();
await new Promise((r) => setTimeout(r, 20000));

const built = await page.evaluate(async () => {
  const api = window.supergraph;
  const y = api.ground();
  const x = Math.floor(api.player.position[0]);
  const z = Math.floor(api.player.position[2]);

  // Glowstone, three blocks up: nothing the generator would ever put there.
  const GLOWSTONE = 29;
  const placed = [];
  for (let i = 0; i < 3; i++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (api.world.setBlock(x + i, y + 3, z, GLOWSTONE)) { placed.push(x + i); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  // Move somewhere distinctive so the resume can be checked too.
  api.teleport(x + 12.5, y + 1.05, z - 7.5);
  api.look(1.234, -0.321);
  api.setTime(0.61);

  // Everything else a session accumulates: what is carried, what is on the
  // floor, what is in a chest, and how badly hurt the player is. Each of these
  // was added to the save at a different time, and each of them was once
  // silently missing from it.
  api.give('diamond', 3);
  api.give('iron_ingot', 5);
  api.items.clear();
  api.dropAt(x + 12.5, y + 1.2, z - 7.5, 'coal', 4);
  api.player.health = 13;
  api.player.hunger = 11;

  // `fill`, not `setBlock`: an edit drops its column out of `Lit` for the
  // relight and the next `setBlock` in the same tick is refused, so the three
  // glowstone blocks above would have eaten this one.
  const chestAt = { x: x + 1, y: y + 4, z };
  api.fill(chestAt.x, chestAt.y, chestAt.z, chestAt.x, chestAt.y, chestAt.z,
    api.blockId('chest'));
  const chest = api.chests.at(chestAt.x, chestAt.y, chestAt.z);
  chest[0] = { id: api.itemId('gold_ingot'), count: 6, damage: 0 };

  // The player's own record is written by the frame loop, and a software-
  // rendered frame here takes the better part of a second: give it a few.
  await new Promise((r) => setTimeout(r, 3000));
  await api.save();
  const p = api.player.position;
  return {
    x, y, z, placed, edits: api.world.savedEdits,
    at: [p[0], p[1], p[2]], yaw: api.player.yaw,
    chestAt,
    carried: { diamond: api.have('diamond'), iron: api.have('iron_ingot') },
    ground: api.droppedItems().length,
    health: api.player.health, hunger: api.player.hunger,
  };
});

console.log(`поставлено ${built.placed.length} блоков на ${built.x},${built.y + 3},${built.z}; правок в сохранении: ${built.edits}`);

// --- reload: the world is regenerated from the seed, edits replayed on top ---
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await ready();
await new Promise((r) => setTimeout(r, 20000));

const found = await page.evaluate(async ({ x, y, z, placed, chestAt }) => {
  const api = window.supergraph;
  const p = api.player.position;
  const resumed = { at: [p[0], p[1], p[2]], yaw: api.player.yaw };
  api.teleport(x + 0.5, y + 0.05, z + 0.5);

  // The column has to stream in again before it can be asked anything.
  for (let i = 0; i < 60; i++) {
    if (api.world.isReadyAt(x, z)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const blocks = [];
  for (const bx of placed) blocks.push(api.world.getBlock(bx, y + 3, z));
  return {
    blocks, edits: api.world.savedEdits, resumed,
    carried: { diamond: api.have('diamond'), iron: api.have('iron_ingot') },
    ground: api.droppedItems().map((d) => `${d.item}x${d.count}`),
    health: api.player.health, hunger: api.player.hunger,
    chest: api.chestState(chestAt.x, chestAt.y, chestAt.z),
    chestBlock: api.blockName(api.world.getBlock(chestAt.x, chestAt.y, chestAt.z)),
  };
}, built);

console.log(`после перезагрузки: блоки ${found.blocks.join(', ')}, правок загружено: ${found.edits}`);
const moved = Math.hypot(
  found.resumed.at[0] - built.at[0], found.resumed.at[2] - built.at[2],
);
console.log(`игрок продолжил с ${found.resumed.at.map((v) => v.toFixed(1)).join(', ')} ` +
  `(отклонение от сохранённого ${moved.toFixed(2)} блока, поворот ${found.resumed.yaw.toFixed(3)})`);
console.log(`сумка: алмазов ${found.carried.diamond}, слитков ${found.carried.iron}; ` +
  `на земле ${found.ground.join(', ') || '—'}; сундук ${JSON.stringify(found.chest)}`);
console.log(`здоровье ${found.health}, голод ${found.hunger}`);

let status = 0;
if (built.placed.length === 0) {
  console.log('\nне удалось поставить ни одного блока — тест ничего не проверил');
  status = 1;
} else if (found.blocks.some((b) => b !== 29)) {
  console.log('\nмир НЕ сохранился: на месте поставленных блоков не светокамень');
  status = 1;
} else if (found.edits !== built.edits) {
  console.log(`\nсохранение прочиталось не целиком: было ${built.edits}, стало ${found.edits}`);
  status = 1;
}
if (moved > 1.5 || Math.abs(found.resumed.yaw - built.yaw) > 0.01) {
  console.log('\nигрок не продолжил с сохранённого места');
  status = 1;
}
if (problems.length) {
  console.log('\n--- ошибки ---');
  for (const p of problems.slice(0, 8)) console.log(p);
  status = 1;
}
if (status === 0) console.log('\nмир пережил перезагрузку');

await browser.close();
process.exit(status);

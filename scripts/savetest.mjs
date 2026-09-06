/**
 * Checks that the world survives a reload.
 *
 * Places a block, flushes the save, reloads the page from scratch and looks for
 * the block again. This is the one property that cannot be verified by reading
 * the code: it depends on the browser's storage, on the edits being in memory
 * before the first column is generated, and on them being replayed at the one
 * moment when nothing has read the terrain yet.
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
  await api.world.flushSave();
  return { x, y, z, placed: placed.length, edits: api.world.savedEdits };
});

console.log(`поставлено ${built.placed} блоков на ${built.x},${built.y + 3},${built.z}; правок в сохранении: ${built.edits}`);

// --- reload: the world is regenerated from the seed, edits replayed on top ---
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await ready();
await new Promise((r) => setTimeout(r, 20000));

const found = await page.evaluate(async ({ x, y, z, placed }) => {
  const api = window.supergraph;
  api.teleport(x + 0.5, y + 0.05, z + 0.5);

  // The column has to stream in again before it can be asked anything.
  for (let i = 0; i < 60; i++) {
    if (api.world.isReadyAt(x, z)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const blocks = [];
  for (let i = 0; i < placed; i++) blocks.push(api.world.getBlock(x + i, y + 3, z));
  return { blocks, edits: api.world.savedEdits };
}, built);

console.log(`после перезагрузки: блоки ${found.blocks.join(', ')}, правок загружено: ${found.edits}`);

let status = 0;
if (built.placed === 0) {
  console.log('\nне удалось поставить ни одного блока — тест ничего не проверил');
  status = 1;
} else if (found.blocks.some((b) => b !== 29)) {
  console.log('\nмир НЕ сохранился: на месте поставленных блоков не светокамень');
  status = 1;
} else if (found.edits !== built.edits) {
  console.log(`\nсохранение прочиталось не целиком: было ${built.edits}, стало ${found.edits}`);
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

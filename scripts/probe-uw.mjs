/**
 * Reads back the player's fluid state and the pixel under the crosshair while
 * submerged. Written for one question — whether the composite's underwater
 * branch is running at all — and kept because "is the camera actually in the
 * water" is the first thing to check every time it looks like it is not.
 *
 * Usage: node scripts/probe-uw.mjs [url]
 */
import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const b = await launch({
  executablePath: CHROME, headless: true,
  args: ['--window-size=1280,720', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
p.on('pageerror', (e) => console.log('pageerror:', e.message));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 });
await p.evaluate(() => document.getElementById('overlay')?.setAttribute('hidden', ''));
await new Promise((r) => setTimeout(r, 20000));
await p.evaluate(() => {
  const a = window.supergraph;
  a.setTime(0.42); a.findViewpoint(48); a.player.flying = true;
});
await new Promise((r) => setTimeout(r, 12000));

const spot = await p.evaluate(() => {
  const { world, player } = window.supergraph;
  const cx = Math.floor(player.position[0]);
  const cz = Math.floor(player.position[2]);
  for (let i = 0; i < 6000; i++) {
    const a = i * 2.399963;
    const d = Math.sqrt(i / 6000) * 220;
    const x = cx + Math.round(Math.cos(a) * d);
    const z = cz + Math.round(Math.sin(a) * d);
    if (!world.isReadyAt(x, z)) continue;
    if (world.getBlock(x, 60, z) !== 31) continue;
    if (world.getBlock(x, 56, z) !== 31) continue;
    return { x, y: 58, z };
  }
  return null;
});
console.log('deep', spot);

await p.evaluate((s) => {
  window.supergraph.teleport(s.x + 0.5, s.y, s.z + 0.5);
  window.supergraph.faceSun(1.2, -0.05);
}, spot);
await new Promise((r) => setTimeout(r, 14000));

console.log(await p.evaluate(() => {
  const { player, world } = window.supergraph;
  const x = Math.floor(player.position[0]);
  const y = Math.floor(player.position[1] + 1.64);
  const z = Math.floor(player.position[2]);
  return {
    pos: [...player.position],
    headUnderwater: player.headUnderwater,
    submersion: player.submersion,
    blockAtEye: world.getBlock(x, y, z),
  };
}));

writeFileSync('scripts/probe-uw.png', await p.screenshot({ type: 'png' }));
console.log('shot: scripts/probe-uw.png');
await b.close();

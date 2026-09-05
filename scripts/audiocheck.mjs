/**
 * Checks that sound actually works.
 *
 * Audio is the one subsystem a screenshot cannot verify, and the smoke test
 * never touches it: it drives the game through the debug handle and never
 * presses Play, which is the gesture the audio context needs. So this presses
 * it, fires one of every kind of sound, and reports which sample groups
 * decoded — a group that never appears in `loaded` is a file the engine asked
 * for and did not get.
 *
 * With nothing extracted into public/sounds/ the expected result is
 * `usingSamples=false` and an empty list: the engine then synthesises, which is
 * silent to this check but audible in the game.
 *
 * Usage: node scripts/audiocheck.mjs [url]
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
    '--window-size=1280,720',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // Headless has no speakers; this keeps the context from being suspended
    // for want of one, so decoding and scheduling still run for real.
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);

await page.click('#play');
await new Promise((r) => setTimeout(r, 2000));

// One of every kind, on blocks from different sound families: grass block,
// stone, oak planks, sand, glass.
await page.evaluate(() => {
  const a = window.supergraph.audio;
  a.step(5);        // grass block
  a.step(1);        // stone
  a.dig(24);        // oak planks
  a.place(7);       // sand
  a.dig(30);        // glass — the one material that shatters instead
  a.land(9, 1);     // hard landing on stone
  a.update(0.1, { rain: 0.8, wind: 0.6, skyVisibility: 1, underwater: false });
  // A minute of darkness in one step, to make the cave ambience fire now.
  a.update(70, { rain: 0, wind: 0.3, skyVisibility: 0, underwater: true });
});

// Fetching and decoding a group takes a moment; the first call of each kind is
// expected to be dropped, which is exactly what the engine does at runtime.
await new Promise((r) => setTimeout(r, 4000));

const state = await page.evaluate(() => window.supergraph.audio.state());

console.log(`контекст:     ${state.contextState}`);
console.log(`сэмплы:       ${state.usingSamples ? 'да' : 'нет (синтез)'}`);
console.log(`загружено:    ${state.loaded.length ? state.loaded.join(', ') : '—'}`);
if (state.pending.length) console.log(`в процессе:   ${state.pending.join(', ')}`);

let status = 0;
if (state.contextState !== 'running') {
  console.log('\nконтекст не запустился');
  status = 1;
}
if (state.usingSamples && state.loaded.length === 0) {
  console.log('\nманифест есть, но ни одна группа не декодировалась');
  status = 1;
}
if (problems.length) {
  console.log('\n--- ошибки ---');
  for (const p of problems.slice(0, 10)) console.log(p);
  status = 1;
}
if (status === 0) console.log('\nзвук работает');

await browser.close();
process.exit(status);

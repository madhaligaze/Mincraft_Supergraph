/**
 * Headless smoke test.
 *
 * Loads the running dev server in Chrome, captures every console message and
 * page error, waits for the loader to finish, then screenshots a frame.
 *
 * Shader compilation only happens at runtime, so this is the only way to know
 * the GLSL is actually valid — `tsc` cannot see inside a template of GLSL.
 *
 * Usage: node scripts/smoke.mjs [url] [outputPng]
 */

import { launch } from 'puppeteer-core';
import { writeFileSync, existsSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = process.argv[3] ?? 'scripts/smoke.png';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('Chrome не найден');
  process.exit(2);
}

const browser = await launch({
  executablePath,
  headless: true,
  args: [
    '--window-size=1280,720',
    // Software GL: slower than the real driver but a stricter GLSL validator,
    // which is exactly what a compile smoke test wants.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-features=SharedArrayBuffer',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const messages = [];
page.on('console', (msg) => {
  messages.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', (err) => {
  messages.push({ type: 'pageerror', text: err.message + '\n' + (err.stack ?? '') });
});
page.on('requestfailed', (req) => {
  messages.push({ type: 'requestfailed', text: `${req.url()} ${req.failure()?.errorText}` });
});

let status = 0;
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for either the play button to enable or the loader to report a failure.
  const outcome = await page.waitForFunction(
    () => {
      const play = document.getElementById('play');
      const label = document.getElementById('loader-label');
      if (play && !play.disabled) return { ready: true, label: label?.textContent ?? '' };
      if (label && label.style.color) return { ready: false, label: label.textContent ?? '' };
      return null;
    },
    { timeout: 180000, polling: 500 },
  ).then((h) => h.jsonValue()).catch((e) => ({ ready: false, label: `timeout: ${e.message}` }));

  console.log(`loader: ready=${outcome.ready} label="${outcome.label}"`);
  if (!outcome.ready) status = 1;

  // Headless Chrome cannot grant pointer lock, so drive the camera through the
  // debug handle instead of clicking Play.
  await page.evaluate(() => {
    document.getElementById('overlay')?.setAttribute('hidden', '');
    const api = window.supergraph;
    if (api) {
      api.hud.toggleStats();
      // Look slightly downward from the spawn so both ground and sky are in frame.
      api.look(0.7, -0.18);
    }
  });
  await new Promise((r) => setTimeout(r, 12000));

  const stats = await page.evaluate(() => document.getElementById('stats')?.textContent ?? '');
  if (stats) console.log('--- stats ---\n' + stats);

  const shot = await page.screenshot({ type: 'png' });
  writeFileSync(OUT, shot);
  console.log(`screenshot: ${OUT}`);
} catch (error) {
  console.error('smoke failed:', error.message);
  status = 1;
}

const problems = messages.filter(
  (m) => m.type === 'error' || m.type === 'pageerror' || m.type === 'requestfailed',
);

if (problems.length > 0) {
  console.log(`--- ${problems.length} problem(s) ---`);
  for (const m of problems.slice(0, 12)) {
    console.log(`[${m.type}] ${m.text.slice(0, 3000)}`);
    console.log('---');
  }
  status = 1;
} else {
  console.log('no console errors');
}

const warnings = messages.filter((m) => m.type === 'warning');
if (warnings.length > 0) {
  console.log(`--- ${warnings.length} warning(s) ---`);
  for (const m of warnings.slice(0, 6)) console.log(`[warn] ${m.text.slice(0, 600)}`);
}

await browser.close();
process.exit(status);

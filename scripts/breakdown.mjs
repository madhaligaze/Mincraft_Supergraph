/**
 * Per-feature cost breakdown on the real GPU.
 *
 * Measures a baseline preset, then turns one feature off at a time and
 * re-measures. The delta in frame time is that feature's cost. This is the only
 * way to know where the milliseconds go — reasoning about it from the shader
 * source is how you end up optimising something that was never the problem.
 *
 * Usage: node scripts/breakdown.mjs [url] [preset] [secondsPerCase]
 */

import { launch } from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PRESET = process.argv[3] ?? 'medium';
const SECONDS = Number(process.argv[4] ?? 10);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

/** Each case turns one thing off relative to the preset. */
const CASE_SETS = {
  features: [
    { name: 'no clouds', changes: { cloudMode: 'off' } },
    { name: 'no shadows', changes: { shadowsEnabled: false } },
    { name: 'no ssao', changes: { ssaoEnabled: false } },
    { name: 'no grass', changes: { grassEnabled: false } },
    { name: 'no taa', changes: { taaEnabled: false } },
    { name: 'half res', changes: { resolutionScale: 0.6 } },
    { name: 'rd 4', changes: { renderDistance: 4 } },
  ],
  // Parallax is the one effect whose cost is bounded by distance rather than
  // by geometry, so the range case matters as much as the step count.
  parallax: [
    { name: 'no pom', changes: { parallaxEnabled: false } },
    { name: 'pom 4 steps', changes: { parallaxSteps: 4 } },
    { name: 'pom 16 steps', changes: { parallaxSteps: 16 } },
    { name: 'pom 32 steps', changes: { parallaxSteps: 32 } },
    { name: 'pom + selfshadow', changes: { parallaxShadows: true } },
    { name: 'pom range 8', changes: { parallaxDistance: 8 } },
  ],
  // Splits the shadow cost into "drawing the maps" (cascades, size) versus
  // "sampling them" (filter taps).
  shadows: [
    { name: 'no shadows', changes: { shadowsEnabled: false } },
    { name: 'filter 1 (2x2)', changes: { shadowFilter: 1 } },
    { name: '1 cascade', changes: { shadowCascades: 1 } },
    { name: 'map 512', changes: { shadowMapSize: 512 } },
    { name: 'distance 64', changes: { shadowDistance: 64 } },
    { name: 'filter1 + 2casc', changes: { shadowFilter: 1, shadowCascades: 2 } },
  ],
};

const CASES = CASE_SETS[process.argv[5] ?? 'features'] ?? CASE_SETS.features;

const browser = await launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,720',
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-frame-rate-limit',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);
await page.evaluate(() => document.getElementById('overlay')?.setAttribute('hidden', ''));

const gpu = await page.evaluate(() => window.supergraph.gpu);
console.log(`GPU: ${gpu}`);
console.log(`preset: ${PRESET}`);

await new Promise((r) => setTimeout(r, 25000));
await page.evaluate(() => window.supergraph.findViewpoint(48));
await new Promise((r) => setTimeout(r, 15000));

async function measure() {
  await page.evaluate(() => window.supergraph.resetFrameTimes());
  const start = Date.now();
  while (Date.now() - start < SECONDS * 1000) {
    await page.evaluate((t) => window.supergraph.look(t * 0.5, -0.08),
      (Date.now() - start) / 1000);
    await new Promise((r) => setTimeout(r, 120));
  }
  const times = await page.evaluate(() => window.supergraph.frameTimes());
  if (times.length < 5) return null;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return mean;
}

/** Applies the preset, then the case's overrides, and lets things settle. */
async function apply(changes) {
  await page.evaluate((p) => {
    window.supergraph.setPreset(p);
    window.supergraph.setTime(0.36);
  }, PRESET);

  for (const [key, value] of Object.entries(changes)) {
    await page.evaluate((k, v) => window.supergraph.setSetting(k, v), key, value);
  }
  // Shader recompiles and chunk streaming must finish before sampling.
  await new Promise((r) => setTimeout(r, 9000));
}

/**
 * A laptop UHD 620 throttles hard over a multi-minute run, so an absolute
 * frame time measured late in the sequence is not comparable to one measured
 * early. Every case is therefore bracketed by a fresh baseline measurement and
 * reported as a ratio against the mean of its two neighbours, which cancels the
 * slow thermal drift entirely.
 */
const results = [];
let previousBaseline = null;

await apply({});
previousBaseline = await measure();
console.log(`baseline (cold)    ${previousBaseline.toFixed(1)} ms   ${(1000 / previousBaseline).toFixed(1)} fps`);

for (const testCase of CASES) {
  if (testCase.name === 'baseline') continue;

  await apply(testCase.changes);
  const caseMs = await measure();

  await apply({});
  const nextBaseline = await measure();

  const baseline = (previousBaseline + nextBaseline) / 2;
  previousBaseline = nextBaseline;

  if (caseMs === null || !baseline) continue;

  const savedMs = baseline - caseMs;
  const row = {
    case: testCase.name,
    caseMs: caseMs.toFixed(1),
    baselineMs: baseline.toFixed(1),
    savedMs: savedMs.toFixed(1),
    savedPercent: ((savedMs / baseline) * 100).toFixed(0),
  };
  results.push(row);
  console.log(
    `${row.case.padEnd(18)} ${row.caseMs.padStart(7)} ms  ` +
    `(база ${row.baselineMs.padStart(6)})  ` +
    `экономия ${row.savedMs.padStart(6)} ms  ${row.savedPercent.padStart(4)}%`,
  );
}

writeFileSync('scripts/breakdown.json', JSON.stringify({ gpu, preset: PRESET, results }, null, 2));
await browser.close();

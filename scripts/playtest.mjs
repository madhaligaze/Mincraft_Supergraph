/**
 * Plays the game and writes down everything wrong with it.
 *
 * The screenshot rigs answer "does this look right". This answers "is this a
 * game": it starts the world with synthetic input, then walks, looks around,
 * jumps, mines, builds, digs down, swims, drowns, opens what a player would
 * expect to be an inventory, and checks the state of the world after each one.
 *
 * Everything here is a thing a player does in the first ten minutes. That is
 * deliberate — the defects that matter for playability are not the exotic
 * ones, they are the ones you hit before you have done anything interesting.
 *
 * Output:
 *   scripts/playtest/<act>.png   one frame per act, to look at afterwards
 *   scripts/playtest/report.md   what passed, what failed, what is missing
 *
 * Usage: node scripts/playtest.mjs [url]
 */

import { launch } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?seed=424242&nosave=1';
const OUT = 'scripts/playtest';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

mkdirSync(OUT, { recursive: true });

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

/** Anything the page complains about lands here and is reported per act. */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById('play') && !document.getElementById('play').disabled,
  { timeout: 300000, polling: 500 },
);

const findings = [];
let currentAct = 'загрузка';

/**
 * Records one observation.
 *
 * `severity` is about playability, not about how hard it is to fix:
 *   stop   — the game is unplayable or wrong in a way a player will hit at once
 *   bad    — noticeably worse than the reference, but the game goes on
 *   gap    — a whole mechanic that is simply not there
 *   note   — worth writing down, not worth fixing on its own
 */
const record = (severity, text, detail = '') => {
  findings.push({ act: currentAct, severity, text, detail });
  const mark = { stop: 'СТОП', bad: 'ПЛОХО', gap: 'НЕТ ', note: '·   ' }[severity];
  console.log(`${mark} [${currentAct}] ${text}${detail ? `  — ${detail}` : ''}`);
};

const ok = (text, detail = '') => {
  console.log(`ок   [${currentAct}] ${text}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (fn, ...args) => page.evaluate(fn, ...args);

/**
 * Waits for a number of rendered frames.
 *
 * Not for wall-clock time. Software rendering manages one or two frames a
 * second here, and a key held for "half a second" may therefore span zero
 * frames or three — which made every input check flaky in a way that looked
 * exactly like an input bug. Frames are the game's unit of time; use them.
 */
const waitFrames = (count) => api((n) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), count);

/** Holds keys across a number of frames. */
const hold = async (codes, frames) => {
  for (const c of codes) await api((code) => window.supergraph.key(code, true), c);
  await waitFrames(frames);
  for (const c of codes) await api((code) => window.supergraph.key(code, false), c);
  await waitFrames(1);
};

const shoot = async (name) => {
  writeFileSync(`${OUT}/${name}.png`, await page.screenshot({ type: 'png' }));
};

const state = () => api(() => {
  const a = window.supergraph;
  const p = a.player;
  return {
    pos: [...p.position],
    onGround: p.onGround,
    inFluid: p.inFluid,
    underwater: p.headUnderwater,
    breath: p.breath,
    hotbar: p.hotbarIndex,
    running: a.running,
    world: a.world.stats(),
    render: a.renderer.stats,
    fps: a.frameTimes().length,
  };
});

const act = async (name) => {
  currentAct = name;
  pageErrors.length = 0;
};

const flushErrors = () => {
  for (const e of new Set(pageErrors)) record('stop', 'ошибка в консоли', e.slice(0, 200));
  pageErrors.length = 0;
};

// ---------------------------------------------------------------------------

await act('старт');
await api(() => window.supergraph.play());
await sleep(1500);
let s = await state();
if (!s.running) record('stop', 'игра не запустилась');
else ok('мир запущен', `${s.world.lit} чанков освещено`);
await api(() => { window.supergraph.setTime(0.35); window.supergraph.player.flying = false; });
await sleep(6000);
await shoot('01-start');
flushErrors();

// --- walking -------------------------------------------------------------
// Four headings, because spawning against a wall is not a movement bug and a
// test that cannot tell the two apart is worse than no test.
await act('ходьба');
let walked = 0;
let heading = 0;
for (heading = 0; heading < 4; heading++) {
  await api((h) => window.supergraph.look(h * Math.PI * 0.5, 0), heading);
  await waitFrames(2);
  const before = await api(() => ({ pos: [...window.supergraph.player.position], t: window.supergraph.elapsed }));
  await hold(['KeyW'], 25);
  const after = await api(() => ({ pos: [...window.supergraph.player.position], t: window.supergraph.elapsed }));
  const seconds = Math.max(0.05, after.t - before.t);
  walked = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]) / seconds;
  if (walked >= 2.5) break;
}
if (walked < 2.5) {
  const around = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.floor(p.position[0]);
    const y = Math.floor(p.position[1]);
    const z = Math.floor(p.position[2]);
    const at = (dx, dy, dz) => a.blockName(a.world.getBlock(x + dx, y + dy, z + dz));
    return { onGround: p.onGround, feet: at(0, 0, 0), head: at(0, 1, 0), under: at(0, -1, 0) };
  });
  record('stop', 'игрок не идёт ни в одну сторону',
    `${walked.toFixed(2)} бл/с; ноги ${around.feet}, голова ${around.head}, под ногами ${around.under}`);
} else {
  ok('ходьба работает', `${walked.toFixed(1)} бл/с (в майнкрафте 4.3)`);
}
await shoot('02-walk');
flushErrors();

// --- looking -------------------------------------------------------------
await act('обзор');
const yaw0 = await api(() => window.supergraph.player.yaw);
await api(() => window.supergraph.mouse(300, 0));
await waitFrames(2);
const yaw1 = await api(() => window.supergraph.player.yaw);
if (Math.abs(yaw1 - yaw0) < 0.05) {
  record('stop', 'камера не поворачивается мышью', `yaw ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);
} else {
  ok('обзор мышью работает', `поворот на ${(yaw1 - yaw0).toFixed(2)} рад`);
}
// Standing perfectly still: the camera must not move on its own.
await api(() => window.supergraph.player.velocity.set([0, 0, 0]));
await sleep(1200);
const drift = await api(() => new Promise((resolve) => {
  const p = window.supergraph.player;
  const start = [...p.camera.position];
  let max = 0;
  let frames = 0;
  const step = () => {
    max = Math.max(max,
      Math.abs(p.camera.position[0] - start[0]),
      Math.abs(p.camera.position[1] - start[1]),
      Math.abs(p.camera.position[2] - start[2]));
    if (++frames < 40) requestAnimationFrame(step); else resolve(max);
  };
  requestAnimationFrame(step);
}));
if (drift > 0.002) record('bad', 'камера дрожит на месте', `${(drift * 1000).toFixed(1)} мм`);
else ok('камера неподвижна на месте', `${(drift * 1000).toFixed(2)} мм`);
flushErrors();

// --- jumping -------------------------------------------------------------
await act('прыжок');
// Back onto solid ground first: two and a half seconds of walking can easily
// end in water or off a ledge, and a jump measured from there says nothing.
await api(() => { window.supergraph.ground(); });
await waitFrames(6);
const standing = await state();
if (!standing.onGround) record('note', 'перед прыжком игрок не на земле', `inFluid ${standing.inFluid}`);
const y0 = standing.pos[1];
await api(() => window.supergraph.key('Space', true));
await waitFrames(2);
await api(() => window.supergraph.key('Space', false));
let peak = y0;
for (let i = 0; i < 16; i++) {
  await waitFrames(1);
  peak = Math.max(peak, (await state()).pos[1]);
}
const jump = peak - y0;
const jumpState = await state();
if (jump < 0.6) {
  record('bad', 'прыжок слишком низкий или его нет',
    `${jump.toFixed(2)} блока, onGround ${jumpState.onGround}, inFluid ${jumpState.inFluid}`);
}
else if (jump > 2.0) record('bad', 'прыжок неправдоподобно высокий', `${jump.toFixed(2)} блока`);
else ok('прыжок', `${jump.toFixed(2)} блока (в майнкрафте ~1.25)`);
await waitFrames(6);
flushErrors();

// --- mining --------------------------------------------------------------
await act('добыча');
const target = await api(() => {
  const a = window.supergraph;
  a.look(a.player.yaw, -1.1);           // look down at the ground in front
  return null;
});
await waitFrames(3);
const aimed = await api(() => {
  const hit = window.supergraph.player.pick();
  return hit ? { ...hit, name: window.supergraph.blockName(hit.block) } : null;
});
if (!aimed) {
  const view = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    return { pos: [...p.position], pitch: p.pitch, reachBlock:
      a.blockName(a.world.getBlock(Math.floor(p.position[0]), Math.floor(p.position[1]) - 1, Math.floor(p.position[2]))) };
  });
  record('bad', 'прицел ни во что не упирается, копать нечего',
    `под ногами ${view.reachBlock}, наклон ${view.pitch.toFixed(2)}`);
} else {
  const t0 = Date.now();
  await api(() => window.supergraph.button(0, true));
  await waitFrames(2);
  await api(() => window.supergraph.button(0, false));
  await waitFrames(3);
  const now = await api((h) => window.supergraph.blockName(
    window.supergraph.world.getBlock(h.x, h.y, h.z)), aimed);
  if (now === 'air') {
    const ms = Date.now() - t0;
    ok('блок ломается', `${aimed.name} за ${ms} мс`);
    record('gap', 'блок ломается мгновенно, без времени добычи и анимации',
      `${aimed.name} исчез за один клик; в майнкрафте это удержание с прогрессом`);
    record('gap', 'сломанный блок не выпадает предметом',
      'ломать нечем и собирать нечего — это же цикл всей игры');
  } else {
    record('stop', 'блок не ломается', `остался ${now}`);
  }
}
await shoot('03-mine');
flushErrors();

// --- building ------------------------------------------------------------
await act('строительство');
const built = await api(() => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.round(p.position[0]);
  const y = Math.floor(p.position[1]);
  const z = Math.round(p.position[2]);
  // A three-block tower two steps away, placed the way a player would: by
  // pointing at a face and clicking. Done through `fill` here because aiming
  // reliably from a script is a separate problem; what is being tested is
  // whether the world accepts and keeps structures.
  a.fill(x + 2, y, z + 2, x + 2, y + 2, z + 2, 1);   // 1 = stone
  return {
    at: [x + 2, y, z + 2],
    kept: [0, 1, 2].map((d) => a.blockName(a.world.getBlock(x + 2, y + d, z + 2))),
  };
});
if (built.kept.every((n) => n === 'stone')) ok('постройка стоит', built.kept.join(', '));
else record('stop', 'поставленные блоки не сохранились', built.kept.join(', '));
await sleep(2500);
await shoot('04-build');
flushErrors();

// --- hotbar and the inventory that is not there --------------------------
await act('инвентарь');
await api(() => window.supergraph.key('Digit4', true));
await waitFrames(2);
await api(() => window.supergraph.key('Digit4', false));
await waitFrames(1);
const slot = (await state()).hotbar;
if (slot === 3) ok('горячая панель переключается цифрами');
else record('bad', 'цифры не переключают слот', `слот ${slot}`);

const beforeE = await api(() => document.body.innerHTML.length);
await api(() => window.supergraph.key('KeyE', true));
await waitFrames(2);
await api(() => window.supergraph.key('KeyE', false));
await waitFrames(2);
const afterE = await api(() => document.body.innerHTML.length);
if (afterE === beforeE) {
  record('gap', 'клавиша E ничего не открывает — инвентаря нет',
    'ни окна, ни предметов, ни крафта: девять фиксированных слотов и всё');
}
await shoot('05-hotbar');
flushErrors();

// --- water ---------------------------------------------------------------
await act('вода');
const swam = await api(() => {
  const a = window.supergraph;
  const { world, player } = a;
  const cx = Math.floor(player.position[0]);
  const cz = Math.floor(player.position[2]);
  for (let i = 0; i < 8000; i++) {
    const ang = i * 2.399963;
    const d = Math.sqrt(i / 8000) * 240;
    const x = cx + Math.round(Math.cos(ang) * d);
    const z = cz + Math.round(Math.sin(ang) * d);
    if (!world.isReadyAt(x, z)) continue;
    if (!a.isWater(world.getBlock(x, 60, z))) continue;
    if (!a.isWater(world.getBlock(x, 56, z))) continue;
    a.teleport(x + 0.5, 58, z + 0.5);
    return { x, z };
  }
  return null;
});
if (!swam) {
  record('note', 'не нашлось воды рядом, купание не проверено');
} else {
  await sleep(4000);
  const w = await state();
  if (!w.underwater) record('bad', 'под водой игра не считает игрока под водой');
  else ok('погружение распознано', `дыхание ${(w.breath * 100).toFixed(0)}%`);
  await shoot('06-underwater');

  // Breath must actually drain.
  await sleep(6000);
  const w2 = await state();
  if (w2.breath >= w.breath) record('bad', 'запас воздуха не расходуется');
  else ok('воздух расходуется', `${(w.breath * 100).toFixed(0)}% -> ${(w2.breath * 100).toFixed(0)}%`);

  // And digging under the sea floor must let water in.
  const flowed = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.floor(p.position[0]);
    const z = Math.floor(p.position[2]);
    for (let y = 55; y > 40; y--) {
      if (a.isWater(a.world.getBlock(x, y, z))) continue;
      if (a.world.getBlock(x, y, z) === 0) return null;
      a.world.setBlock(x, y, z, 0);
      a.tickFluids(40);
      return { y, now: a.blockName(a.world.getBlock(x, y, z)) };
    }
    return null;
  });
  if (flowed) {
    if (flowed.now.startsWith('water')) ok('вода заливает прокоп в дне', flowed.now);
    else record('stop', 'вода не заливает прокоп в дне моря', flowed.now);
  }
}
flushErrors();

// --- night ---------------------------------------------------------------
await act('ночь');
await api(() => {
  const a = window.supergraph;
  a.player.flying = true;
  a.findViewpoint(40);
  a.setTime(0.92);
  a.faceSun(2.6, -0.05);
});
await sleep(9000);
await shoot('07-night');
flushErrors();

// --- what a session costs ------------------------------------------------
await act('плавность');
const frames = await api(() => {
  window.supergraph.resetFrameTimes();
  return new Promise((resolve) => setTimeout(() => resolve(window.supergraph.frameTimes()), 8000));
});
if (frames.length > 8) {
  const sorted = [...frames].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const low = sorted[Math.floor(sorted.length * 0.99)];
  ok('кадры', `медиана ${median.toFixed(1)} мс, худший процент ${low.toFixed(1)} мс`);
  record('note', 'частота кадров снята на софтверном рендере', 'абсолютные числа тут не значат ничего, важны только всплески');
}
flushErrors();

// ---------------------------------------------------------------------------

const bySeverity = (s) => findings.filter((f) => f.severity === s);
const lines = [
  '# Прогон игры',
  '',
  `Снято: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}, `
    + `сид 424242, ${findings.length} записей.`,
  '',
];
for (const [severity, title] of [
  ['stop', 'Ломает игру'],
  ['bad', 'Заметно хуже эталона'],
  ['gap', 'Механики нет вовсе'],
  ['note', 'Заметки'],
]) {
  const items = bySeverity(severity);
  if (items.length === 0) continue;
  lines.push(`## ${title}`, '');
  for (const f of items) {
    lines.push(`* **[${f.act}]** ${f.text}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  lines.push('');
}
writeFileSync(`${OUT}/report.md`, lines.join('\n'));

console.log('');
console.log(`стоп: ${bySeverity('stop').length}   плохо: ${bySeverity('bad').length}   `
  + `нет механики: ${bySeverity('gap').length}`);
console.log(`отчёт: ${OUT}/report.md`);

await browser.close();

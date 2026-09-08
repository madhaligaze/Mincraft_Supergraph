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

/**
 * Records something that works.
 *
 * Kept in the report as well as on the console: a run with nothing wrong used
 * to produce an empty file, which is indistinguishable from a run that never
 * happened. What passed — and the numbers it passed with — is the only record
 * of what the game currently does.
 */
const passes = [];
const ok = (text, detail = '') => {
  passes.push({ act: currentAct, text, detail });
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
// Both the camera and the player are measured, because they are two
// different claims. "The camera jitters" is a rendering defect; "the player
// slid a block" is the world doing something — sand giving way underfoot, for
// instance — and a test that cannot tell them apart blames the wrong one.
const drift = await api(() => new Promise((resolve) => {
  const p = window.supergraph.player;
  const startCam = [...p.camera.position];
  const startPos = [...p.position];
  let camera = 0;
  let body = 0;
  let frames = 0;
  const step = () => {
    for (let i = 0; i < 3; i++) {
      camera = Math.max(camera, Math.abs(p.camera.position[i] - startCam[i]));
      body = Math.max(body, Math.abs(p.position[i] - startPos[i]));
    }
    if (++frames < 40) requestAnimationFrame(step);
    else resolve({ camera, body, onGround: p.onGround });
  };
  requestAnimationFrame(step);
}));
if (drift.body > 0.002) {
  record('note', 'игрок сам сдвинулся, дрожание камеры не проверено',
    `тело ${(drift.body * 1000).toFixed(0)} мм, камера ${(drift.camera * 1000).toFixed(0)} мм`
    + `, на земле ${drift.onGround}`);
} else if (drift.camera > 0.002) {
  record('bad', 'камера дрожит на месте', `${(drift.camera * 1000).toFixed(1)} мм`);
} else {
  ok('камера неподвижна на месте', `${(drift.camera * 1000).toFixed(2)} мм`);
}
flushErrors();

// --- jumping -------------------------------------------------------------
await act('прыжок');
// Back onto solid ground first: two and a half seconds of walking can easily
// end in water or off a ledge, and a jump measured from there says nothing.
await api(() => { window.supergraph.ground(); });
await waitFrames(6);
const standing = await state();
if (!standing.onGround) record('note', 'перед прыжком игрок не на земле', `inFluid ${standing.inFluid}`);
// Headroom first. A jump measured under a canopy is a measurement of the
// canopy, and reporting that as "the jump is broken" is how a test lies.
const headroom = await api(() => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.floor(p.position[0]);
  const z = Math.floor(p.position[2]);
  const feet = Math.floor(p.position[1]);
  for (let dy = 2; dy <= 4; dy++) {
    if (a.world.isSolidAt(x, feet + dy, z)) {
      return { blocked: dy, name: a.blockName(a.world.getBlock(x, feet + dy, z)) };
    }
  }
  return { blocked: 0, name: null };
});
const y0 = standing.pos[1];
// Held until the player is actually airborne, not for a fixed two frames.
// The jump is level-triggered — it fires on any frame where the button is
// down *and* the feet are on the ground — so two frames that both catch the
// player a hair off the ground swallow the whole jump, and the test reported
// a broken jump about one run in three.
await api(() => window.supergraph.key('Space', true));
let peak = y0;
let airborne = false;
for (let i = 0; i < 8 && !airborne; i++) {
  await waitFrames(1);
  const s = await state();
  peak = Math.max(peak, s.pos[1]);
  airborne = !s.onGround;
}
await api(() => window.supergraph.key('Space', false));
for (let i = 0; i < 16; i++) {
  await waitFrames(1);
  peak = Math.max(peak, (await state()).pos[1]);
}
const jump = peak - y0;
const jumpState = await state();
if (jump < 0.6 && headroom.blocked > 0) {
  record('note', 'прыжок не измерен: над головой потолок',
    `${headroom.name} в ${headroom.blocked} блоках`);
} else if (jump < 0.6) {
  // Everything the next reader will want to know, gathered on the spot:
  // guessing at this from three words in a report cost two sessions.
  const why = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.floor(p.position[0]);
    const y = Math.floor(p.position[1]);
    const z = Math.floor(p.position[2]);
    const at = (dy) => a.blockName(a.world.getBlock(x, y + dy, z));
    return {
      under: at(-1), feet: at(0), head: at(1), above: at(2),
      vy: +p.velocity[1].toFixed(2), flying: p.flying, dead: p.dead,
      ready: a.world.isReadyAt(x, z), pending: a.tickReactions(0),
    };
  });
  record('bad', 'прыжок слишком низкий или его нет',
    `${jump.toFixed(2)} блока, onGround ${jumpState.onGround}, inFluid ${jumpState.inFluid}, `
    + JSON.stringify(why));
}
else if (jump > 2.0) record('bad', 'прыжок неправдоподобно высокий', `${jump.toFixed(2)} блока`);
else ok('прыжок', `${jump.toFixed(2)} блока (в майнкрафте ~1.25)`);
await waitFrames(6);
flushErrors();

// --- mining --------------------------------------------------------------
//
// Three separate claims, and they need separating: that holding the button
// makes progress, that the progress takes about as long as it should, and that
// the block leaves something behind.
await act('добыча');

/**
 * Puts the crosshair on one specific block and confirms it is there.
 *
 * Aiming from a script is its own problem, and getting it wrong looks exactly
 * like a broken mechanic: the first run of this act "chopped a log" that was
 * actually a leaf block, and "mined stone" that was actually the dirt the
 * player was standing on. So: hover (no falling), clear the line of sight,
 * stand two and a half blocks away on the +X side, and then *check* what the
 * ray hits before touching a mouse button.
 */
const aimAt = async (bx, by, bz) => {
  await api((b) => {
    const a = window.supergraph;
    a.player.flying = true;
    a.player.velocity.set([0, 0, 0]);
    // Eye height is 1.64, so this puts the eye on the block's middle.
    a.teleport(b.x + 2.5, b.y + 0.5 - 1.64, b.z + 0.5);
  }, { x: bx, y: by, z: bz });

  // Teleporting somewhere the world has not streamed yet is not a defect, but
  // aiming at it is guaranteed to fail; wait for the column to arrive.
  for (let i = 0; i < 90; i++) {
    const ready = await api((b) => window.supergraph.world.isReadyAt(b.x, b.z),
      { x: bx, z: bz });
    if (ready) break;
    await waitFrames(1);
  }

  await api((b) => {
    const a = window.supergraph;
    // Clear the corridor between the camera and the block.
    a.fill(b.x + 1, b.y, b.z, b.x + 3, b.y, b.z, 0);
    // forward = (-sin yaw, ..., -cos yaw), so +PI/2 looks along -X — toward the
    // block from a camera standing on its +X side. The sign of this was wrong
    // first time round and every "mechanic is broken" line in the report came
    // from the crosshair pointing at the scenery behind the player.
    a.look(Math.PI / 2, 0);
  }, { x: bx, y: by, z: bz });
  await waitFrames(3);
  return api((b) => {
    const a = window.supergraph;
    const hit = a.player.pick();
    if (!hit) return { ok: false, name: null };
    return {
      ok: hit.x === b.x && hit.y === b.y && hit.z === b.z,
      name: a.blockName(hit.block),
      at: [hit.x, hit.y, hit.z],
    };
  }, { x: bx, y: by, z: bz });
};

/**
 * Holds the mine button until the aimed block is gone.
 *
 * Returns the *simulated* seconds it took. Wall-clock time is meaningless
 * here — software rendering runs a couple of frames a second — and the frame
 * loop's own clamp is what the game itself uses as the length of a frame.
 */
const mineAimed = async (maxFrames = 200) => {
  const hit = await api(() => {
    const h = window.supergraph.player.pick();
    return h ? { x: h.x, y: h.y, z: h.z, name: window.supergraph.blockName(h.block) } : null;
  });
  if (!hit) return null;

  const start = await api(() => window.supergraph.elapsed);
  await api(() => window.supergraph.button(0, true));
  let progressSeen = 0;
  let frames = 0;
  let gone = false;
  while (frames++ < maxFrames) {
    await waitFrames(1);
    const state = await api((h) => ({
      progress: window.supergraph.breakProgress(),
      block: window.supergraph.blockName(window.supergraph.world.getBlock(h.x, h.y, h.z)),
      t: window.supergraph.elapsed,
    }), hit);
    progressSeen = Math.max(progressSeen, state.progress);
    if (state.block === 'air') { gone = true; break; }
  }
  await api(() => window.supergraph.button(0, false));
  const end = await api(() => window.supergraph.elapsed);
  return { ...hit, seconds: end - start, gone, progressSeen, frames };
};

await api(() => {
  const a = window.supergraph;
  a.look(a.player.yaw, -1.1);           // look down at the ground in front
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
  // A single click must *not* be enough — for a block that takes real time.
  // A flower does not: it is 0.05 hard and goes in a frame in the reference
  // too, so the game is asked how long this one should take rather than being
  // told what the answer ought to be.
  const expected = await api((h) => window.supergraph.breakSeconds(h.block), aimed);
  if (expected > 0.2) {
    await api(() => window.supergraph.button(0, true));
    await waitFrames(1);
    await api(() => window.supergraph.button(0, false));
    await waitFrames(1);
    const afterClick = await api((h) => ({
      block: window.supergraph.blockName(window.supergraph.world.getBlock(h.x, h.y, h.z)),
      progress: window.supergraph.breakProgress(),
    }), aimed);
    if (afterClick.block === 'air') {
      record('bad', 'блок ломается от одного клика, без удержания',
        `${aimed.name} исчез мгновенно, а должен ломаться ${expected.toFixed(2)} с`);
    } else {
      ok('один клик блок не ломает', `${aimed.name} на месте, прогресс сброшен`);
    }
  } else {
    ok('прицел на мгновенном блоке, проверка удержания пропущена',
      `${aimed.name}, ${expected.toFixed(3)} с`);
  }

  const dug = await mineAimed();
  if (!dug || !dug.gone) {
    record('stop', 'блок не ломается удержанием',
      `${aimed.name}, прогресс дошёл до ${(dug?.progressSeen ?? 0).toFixed(2)}`);
  } else {
    ok('блок ломается удержанием',
      `${dug.name} за ${dug.seconds.toFixed(2)} с игрового времени`);

    const drops = await api(() => window.supergraph.droppedItems());
    if (drops.length === 0) {
      record('bad', 'сломанный блок ничего не оставил', `${dug.name} исчез без предмета`);
    } else {
      ok('блок выпал предметом', drops.map((d) => `${d.item} x${d.count}`).join(', '));

      // And walking onto it must put it in the bag.
      await api((d) => window.supergraph.teleport(d.x, d.y + 0.2, d.z), drops[0]);
      let collected = false;
      for (let i = 0; i < 30 && !collected; i++) {
        await waitFrames(1);
        collected = await api(() => window.supergraph.bag().length > 0);
      }
      if (collected) {
        ok('предмет подобран', JSON.stringify(await api(() => window.supergraph.bag())));
      } else {
        const why = await api(() => {
          const a = window.supergraph;
          const p = a.player;
          const g = a.droppedItems();
          return {
            player: [...p.position].map((v) => +v.toFixed(2)),
            ground: g.map((d) => ({ item: d.item, at: [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2)] })),
            distance: g.length > 0
              ? +Math.hypot(g[0].x - p.position[0], g[0].y - p.position[1], g[0].z - p.position[2]).toFixed(2)
              : -1,
            running: a.running,
          };
        });
        record('bad', 'предмет не подбирается', JSON.stringify(why));
      }
    }
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
const opened = await api(() => {
  const el = document.getElementById('inventory');
  return {
    exists: !!el,
    visible: !!el && !el.hidden,
    slots: el ? el.querySelectorAll('.islot').length : 0,
    html: document.body.innerHTML.length,
  };
});
if (!opened.visible) {
  record('stop', 'клавиша E не открывает инвентарь',
    `окно ${opened.exists ? 'есть, но скрыто' : 'не создано'}, DOM ${beforeE} -> ${opened.html}`);
} else if (opened.slots < 36 + 4 + 1) {
  record('bad', 'в окне инвентаря не хватает ячеек',
    `${opened.slots}, ожидается 36 + сетка 2x2 + результат`);
} else {
  ok('E открывает инвентарь', `${opened.slots} ячеек`);
}
await shoot('05-inventory');

// Closing must not eat anything that was in the crafting grid.
await api(() => {
  const a = window.supergraph;
  a.give('dirt', 3);
  a.craftSet(['dirt', null, null, null]);
});
await waitFrames(1);
await api(() => window.supergraph.key('KeyE', true));
await waitFrames(2);
await api(() => window.supergraph.key('KeyE', false));
await waitFrames(2);
const afterClose = await api(() => ({
  visible: !document.getElementById('inventory').hidden,
  dirt: window.supergraph.have('dirt'),
  onGround: window.supergraph.droppedItems().length,
}));
if (afterClose.visible) record('bad', 'инвентарь не закрывается по E');
else if (afterClose.dirt < 3) {
  record('stop', 'предметы из сетки крафта пропали при закрытии',
    `земли ${afterClose.dirt} из 3, на земле ${afterClose.onGround}`);
} else {
  ok('сетка крафта возвращается в сумку при закрытии', `земли ${afterClose.dirt}`);
}
flushErrors();

// --- the survival loop ---------------------------------------------------
//
// The whole reason any of the rest exists: wood -> planks -> sticks -> table
// -> pickaxe -> stone. If this chain runs, the game has a first ten minutes.
await act('цикл выживания');

const craftIn = async (cells, size) => {
  await api((args) => {
    const a = window.supergraph;
    a.openInventory(args.size);
    a.craftSet(args.cells);
  }, { cells, size });
  await waitFrames(1);
  const result = await api(() => window.supergraph.craftResult());
  if (!result) return null;
  // Take it the way a player does: click the result slot.
  await api(() => {
    const el = document.querySelector('#inventory .islot.result');
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  });
  await waitFrames(1);
  // The cursor holds it; clicking an empty bag slot puts it away.
  await api(() => {
    const slots = document.querySelectorAll('#inventory .inv-grid .islot');
    for (const el of slots) {
      if (el.classList.contains('filled')) continue;
      el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      return;
    }
  });
  await waitFrames(1);
  await api(() => window.supergraph.closeInventory());
  await waitFrames(1);
  return result;
};

// Punch a tree. Failing to find one is not a defect in mining, so it is
// reported separately from a failure to break wood.
const tree = await api(() => {
  const a = window.supergraph;
  const { world, player } = a;
  const cx = Math.floor(player.position[0]);
  const cz = Math.floor(player.position[2]);
  for (let i = 0; i < 6000; i++) {
    const ang = i * 2.399963;
    const d = Math.sqrt(i / 6000) * 120;
    const x = cx + Math.round(Math.cos(ang) * d);
    const z = cz + Math.round(Math.sin(ang) * d);
    if (!world.isReadyAt(x, z)) continue;
    const h = world.store.getHeight(x, z);
    for (let y = h; y > h - 8 && y > 40; y--) {
      const name = a.blockName(world.getBlock(x, y, z));
      if (!name.endsWith('_log')) continue;
      return { x, y, z, name };
    }
  }
  return null;
});

if (!tree) {
  record('note', 'рядом не нашлось дерева, цикл выживания не проверен');
} else {
  await api(() => window.supergraph.items.clear());
  const onTree = await aimAt(tree.x, tree.y, tree.z);
  if (!onTree.ok) {
    record('note', 'не удалось навести прицел на бревно', JSON.stringify(onTree));
  }
  const chopped = await mineAimed();
  if (!chopped || !chopped.gone) {
    record('stop', 'бревно не рубится рукой',
      `${tree.name}, прогресс ${(chopped?.progressSeen ?? 0).toFixed(2)}`);
  } else {
    ok('бревно срублено рукой', `${chopped.name} за ${chopped.seconds.toFixed(2)} с`);
  }

  // Collect what fell: standing on a dropped item has to be enough.
  const dropped = await api(() => window.supergraph.droppedItems());
  if (dropped.length === 0) {
    record('bad', 'срубленное бревно ничего не оставило');
  } else {
    await api((d) => {
      const a = window.supergraph;
      a.player.flying = true;
      a.teleport(d.x, d.y, d.z);
    }, dropped[0]);
    await waitFrames(8);
  }
  const logs = await api(() => window.supergraph.have('oak_log')
    + window.supergraph.have('birch_log') + window.supergraph.have('spruce_log'));
  if (logs === 0) record('bad', 'срубленное бревно не попало в сумку');
  else ok('бревно в сумке', `${logs} шт.`);

  await api(() => window.supergraph.give('oak_log', 4));

  // The first craft is done the way a player does it — by clicking a slot in
  // the bag, clicking a cell in the grid, and clicking the result — because
  // that path has three chances to lose an item and none of them show up in a
  // test that fills the grid programmatically.
  await api(() => window.supergraph.openInventory(2));
  await waitFrames(1);
  const dragged = await api(() => {
    const a = window.supergraph;
    const index = a.inventory.slots.findIndex((s) => s && a.blockName(s.id).endsWith('_log'));
    if (index < 0) return null;
    const el = index < 9
      ? document.querySelectorAll('#inventory .inv-hotbar-row .islot')[index]
      : document.querySelectorAll('#inventory .inv-grid:not(.inv-hotbar-row) .islot')[index - 9];
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const cell = document.querySelector('#inventory .inv-craft .islot');
    cell.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    return { index, cursor: a.inventory.cursor, result: a.craftResult() };
  });
  if (!dragged || !dragged.result) {
    record('stop', 'бревно, положенное в сетку мышью, ничего не даёт',
      JSON.stringify(dragged));
  } else {
    ok('бревно в сетке 2x2 даёт доски', `${dragged.result.count} шт.`);
  }
  await api(() => {
    document.querySelector('#inventory .islot.result')
      .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const slots = document.querySelectorAll('#inventory .inv-grid .islot');
    for (const el of slots) {
      if (el.classList.contains('filled')) continue;
      el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      break;
    }
  });
  await waitFrames(1);
  await api(() => window.supergraph.closeInventory());
  await waitFrames(1);
  const planksHeld = await api(() => window.supergraph.have('oak_planks'));
  if (planksHeld <= 0) {
    record('stop', 'скрафченные доски не попали в сумку');
  } else {
    ok('доски в сумке', `${planksHeld} шт.`);
  }

  const sticks = await craftIn(['oak_planks', null, 'oak_planks', null], 2);
  if (!sticks || sticks.item !== 'stick') {
    record('stop', 'палки не крафтятся из досок', JSON.stringify(sticks));
  } else {
    ok('палки скрафчены', `${sticks.count} шт.`);
  }

  await api(() => window.supergraph.give('oak_planks', 8));
  const table = await craftIn(
    ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'], 2);
  if (!table || table.item !== 'crafting_table') {
    record('stop', 'верстак не крафтится', JSON.stringify(table));
  } else {
    ok('верстак скрафчен');
  }

  // Put the table down against a wall of stone and right-click it. Placing on
  // the ground under the player's own feet is refused — correctly, the block
  // would be inside them — so the test builds something to aim at.
  const anchor = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 6;
    const y = Math.floor(p.position[1]);
    const z = Math.round(p.position[2]);
    a.fill(x - 1, y - 1, z - 1, x + 1, y + 2, z + 1, 0);
    a.fill(x, y, z, x, y, z, 1);
    return { x, y, z };
  });
  const onAnchor = await aimAt(anchor.x, anchor.y, anchor.z);
  const holding = await api(() => window.supergraph.equip('crafting_table'));

  if (holding < 0) {
    record('stop', 'верстака нет в сумке, ставить нечего');
  } else if (!onAnchor.ok) {
    record('note', 'не удалось навести прицел для установки', JSON.stringify(onAnchor));
  } else {
    await api(() => window.supergraph.button(2, true));
    await waitFrames(2);
    await api(() => window.supergraph.button(2, false));
    await waitFrames(2);
    // The face the ray hit is +X, so the table lands one block toward the
    // camera.
    const found = await api((b) => {
      const a = window.supergraph;
      return a.blockName(a.world.getBlock(b.x + 1, b.y, b.z)) === 'crafting_table'
        ? { x: b.x + 1, y: b.y, z: b.z } : null;
    }, anchor);

    if (!found) record('bad', 'верстак не ставится правой кнопкой');
    else {
      ok('верстак поставлен', `${found.x} ${found.y} ${found.z}`);
      const left = await api(() => window.supergraph.have('crafting_table'));
      if (left !== 0) {
        record('bad', 'поставленный блок не списался из сумки', `осталось ${left}`);
      } else {
        ok('поставленный блок списан из сумки');
      }

      // Right-click it: the block has to answer instead of being built on.
      const onTable = await aimAt(found.x, found.y, found.z);
      if (!onTable.ok) record('note', 'не навёлся на верстак', JSON.stringify(onTable));
      await api(() => window.supergraph.button(2, true));
      await waitFrames(2);
      await api(() => window.supergraph.button(2, false));
      await waitFrames(2);
      const table3 = await api(() => {
        const el = document.getElementById('inventory');
        return {
          open: el && !el.hidden,
          cells: window.supergraph.inventoryWindow.grid.cells.length,
        };
      });
      if (!table3.open || table3.cells !== 9) {
        record('bad', 'верстак не открывает сетку 3x3',
          `открыт ${table3.open}, ячеек ${table3.cells}`);
      } else {
        ok('верстак открывает сетку 3x3');
      }
      await api(() => window.supergraph.closeInventory());
    }
  }

  // Finally the pickaxe, and the thing it is for: stone that gives cobblestone.
  await api(() => { window.supergraph.give('oak_planks', 3); window.supergraph.give('stick', 2); });
  const pickaxe = await craftIn(
    ['oak_planks', 'oak_planks', 'oak_planks', null, 'stick', null, null, 'stick', null], 3);
  if (!pickaxe || pickaxe.item !== 'wooden_pickaxe') {
    record('stop', 'кирка не крафтится на верстаке', JSON.stringify(pickaxe));
  } else {
    ok('деревянная кирка скрафчена');
  }

  // Stone by hand gives nothing; the same stone with the pickaxe gives
  // cobblestone and takes a fraction of the time. Both are measured, on two
  // identical blocks in the same place, so nothing but the tool differs.
  const bench = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 8;
    const y = Math.floor(p.position[1]);
    const z = Math.round(p.position[2]);
    a.fill(x - 1, y - 1, z - 1, x + 4, y + 2, z + 1, 0);
    a.fill(x, y, z, x, y, z, 1);
    a.items.clear();
    return { x, y, z };
  });

  const emptyHand = await api(() => {
    const a = window.supergraph;
    const empty = a.inventory.slots.findIndex((s, i) => i < 9 && !s);
    if (empty >= 0) a.inventory.selected = empty;
    return empty;
  });
  const onStone = await aimAt(bench.x, bench.y, bench.z);
  if (!onStone.ok) record('note', 'не навёлся на камень', JSON.stringify(onStone));
  const byHand = await mineAimed(80);
  const handDrops = await api(() => window.supergraph.droppedItems());

  await api((b) => {
    const a = window.supergraph;
    a.fill(b.x, b.y, b.z, b.x, b.y, b.z, 1);
    a.items.clear();
    return a.equip('wooden_pickaxe');
  }, bench);
  const onStone2 = await aimAt(bench.x, bench.y, bench.z);
  if (!onStone2.ok) record('note', 'не навёлся на камень с киркой', JSON.stringify(onStone2));
  const byPick = await mineAimed(80);
  const pickDrops = await api(() => window.supergraph.droppedItems());

  if (byHand && byHand.gone && handDrops.length > 0) {
    record('bad', 'камень рукой всё равно даёт булыжник',
      `в эталоне без кирки не выпадает ничего; выпало ${JSON.stringify(handDrops)}`);
  } else if (byHand && byHand.gone) {
    ok('камень рукой ломается, но ничего не даёт', `${byHand.seconds.toFixed(1)} с`);
  } else {
    ok('камень рукой не сломан за отведённое время',
      `прогресс ${(byHand?.progressSeen ?? 0).toFixed(2)}, слот ${emptyHand}`);
  }

  if (!byPick || !byPick.gone) {
    record('bad', 'камень не ломается киркой', JSON.stringify(byPick));
  } else if (!pickDrops.some((d) => d.item === 'cobblestone')) {
    record('stop', 'камень киркой не даёт булыжник', JSON.stringify(pickDrops));
  } else {
    const handTime = byHand && byHand.gone
      ? byHand.seconds.toFixed(2)
      : `>${(byHand?.seconds ?? 0).toFixed(1)}`;
    ok('камень киркой даёт булыжник',
      `${byPick.seconds.toFixed(2)} с против ${handTime} с рукой`);
    // In the reference a wooden pickaxe is about six times faster than a fist.
    if (byHand && byHand.gone && byHand.seconds < byPick.seconds * 2) {
      record('bad', 'кирка почти не ускоряет добычу',
        `${byPick.seconds.toFixed(2)} с против ${byHand.seconds.toFixed(2)} с рукой`);
    }
  }

  const worn = await api(() => window.supergraph.bag()
    .filter((s) => s.item === 'wooden_pickaxe').map((s) => s.damage));
  if (worn.length > 0 && worn[0] > 0) ok('кирка изнашивается', `износ ${worn[0]}`);
  else if (worn.length > 0) record('bad', 'кирка не изнашивается от добычи');
}
await shoot('06-craft');
flushErrors();

// --- smelting ------------------------------------------------------------
//
// The link that decides whether the game has a second hour: iron ore is not a
// pickaxe, and diamond ore only yields to an iron one. Without a furnace the
// whole tool chain stops at stone.
await act('плавка');

const furnaceSpot = await api(() => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.round(p.position[0]) + 10;
  const y = Math.floor(p.position[1]);
  const z = Math.round(p.position[2]);
  a.fill(x - 1, y - 1, z - 1, x + 4, y + 2, z + 1, 0);
  a.fill(x, y, z, x, y, z, 1);
  a.items.clear();
  return { x, y, z };
});

// Eight cobblestone make a furnace, and it goes down against the stone.
const furnaceCrafted = await craftIn([
  'cobblestone', 'cobblestone', 'cobblestone',
  'cobblestone', null, 'cobblestone',
  'cobblestone', 'cobblestone', 'cobblestone',
], 3);
if (!furnaceCrafted || furnaceCrafted.item !== 'furnace') {
  record('stop', 'печь не крафтится из булыжника', JSON.stringify(furnaceCrafted));
} else {
  ok('печь скрафчена');

  const inHand = await api(() => window.supergraph.equip('furnace'));

  const onWall = await aimAt(furnaceSpot.x, furnaceSpot.y, furnaceSpot.z);
  if (inHand < 0 || !onWall.ok) {
    record('note', 'печь не удалось поставить: прицел или слот',
      `${inHand} ${JSON.stringify(onWall)}`);
  } else {
    await api(() => window.supergraph.button(2, true));
    await waitFrames(2);
    await api(() => window.supergraph.button(2, false));
    await waitFrames(2);

    const at = { x: furnaceSpot.x + 1, y: furnaceSpot.y, z: furnaceSpot.z };
    const placedFurnace = await api((f) => window.supergraph.blockName(
      window.supergraph.world.getBlock(f.x, f.y, f.z)), at);

    if (placedFurnace !== 'furnace') {
      record('bad', 'печь не встала', `на месте ${placedFurnace}`);
    } else {
      ok('печь поставлена', `${at.x} ${at.y} ${at.z}`);

      // Right-click opens it; the window must be the furnace one, not a grid.
      const opened = await api((f) => {
        const a = window.supergraph;
        a.openFurnace(f.x, f.y, f.z);
        const el = document.getElementById('inventory');
        return {
          open: el && !el.hidden,
          furnaceShown: !document.querySelector('.inv-furnace').hidden,
          craftHidden: document.querySelector('.inv-craft').hidden,
        };
      }, at);
      if (!opened.open || !opened.furnaceShown || !opened.craftHidden) {
        record('bad', 'окно печи открылось неправильно', JSON.stringify(opened));
      } else {
        ok('печь открывает своё окно, а не сетку крафта');
      }

      // Ore in, coal under, and let it burn.
      await api((f) => {
        window.supergraph.furnaceLoad(f.x, f.y, f.z, 'raw_iron', 'coal');
      }, at);
      const before = await api((f) => window.supergraph.furnaceState(f.x, f.y, f.z), at);
      await api(() => window.supergraph.tickFurnaces(11));
      const after = await api((f) => window.supergraph.furnaceState(f.x, f.y, f.z), at);

      if (!after || !after.output || after.output.item !== 'iron_ingot') {
        record('stop', 'печь не выплавила слиток',
          `было ${JSON.stringify(before)}, стало ${JSON.stringify(after)}`);
      } else {
        ok('печь плавит руду в слиток',
          `${after.output.count} шт. за 11 с, топлива осталось ${after.burn.toFixed(0)} с`);
      }

      const lit = await api((f) => window.supergraph.blockName(
        window.supergraph.world.getBlock(f.x, f.y, f.z)), at);
      if (lit !== 'furnace_lit') {
        record('bad', 'горящая печь не отличается от холодной', `блок ${lit}`);
      } else {
        ok('горящая печь светится', 'блок сменился на furnace_lit');
      }

      // Fuel with nothing to smelt must not burn: that is the check that stops
      // a furnace quietly eating a stack of coal.
      const fuelBefore = await api((f) => {
        const a = window.supergraph;
        const state = a.furnaces.at(f.x, f.y, f.z);
        state.input = null;
        state.burn = 0;
        state.burnTotal = 0;
        return state.fuel ? state.fuel.count : 0;
      }, at);
      await api(() => window.supergraph.tickFurnaces(4));
      // The block swap goes through `setBlock`, which refuses a column that is
      // mid-relight — so the furnace stops being lit within a frame or two, not
      // inside the synchronous tick that put the fire out.
      await waitFrames(4);
      const idle = await api((f) => window.supergraph.furnaceState(f.x, f.y, f.z), at);
      const fuelNow = idle.fuel ? idle.fuel.count : 0;
      if (idle.burn > 0 || fuelNow < fuelBefore) {
        record('bad', 'печь жжёт топливо впустую',
          `топлива ${fuelBefore} -> ${fuelNow}, горение ${idle.burn}`);
      } else if (idle.lit) {
        record('bad', 'потухшая печь осталась горящим блоком', JSON.stringify(idle));
      } else {
        ok('без сырья печь не жжёт топливо и гаснет', `топлива ${fuelNow}`);
      }

      // And breaking it gives back what was inside.
      await api((f) => { window.supergraph.closeInventory(); window.supergraph.items.clear(); }, at);
      const onFurnace = await aimAt(at.x, at.y, at.z);
      if (onFurnace.ok) {
        await api(() => {
          const a = window.supergraph;
          if (a.equip('stone_pickaxe') < 0) { a.give('stone_pickaxe', 1); a.equip('stone_pickaxe'); }
        });
        const broken = await mineAimed(80);
        const spilled = await api(() => window.supergraph.droppedItems());
        if (!broken || !broken.gone) {
          record('bad', 'печь не ломается', JSON.stringify(broken));
        } else if (!spilled.some((d) => d.item === 'iron_ingot')) {
          record('stop', 'сломанная печь съела то, что в ней лежало',
            JSON.stringify(spilled));
        } else {
          ok('сломанная печь возвращает содержимое',
            spilled.map((d) => `${d.item} x${d.count}`).join(', '));
        }
      }
    }
  }
}

// Iron pickaxe, and the one thing only it can do.
await api(() => { window.supergraph.give('iron_ingot', 3); window.supergraph.give('stick', 2); });
const ironPick = await craftIn(
  ['iron_ingot', 'iron_ingot', 'iron_ingot', null, 'stick', null, null, 'stick', null], 3);
if (!ironPick || ironPick.item !== 'iron_pickaxe') {
  record('stop', 'железная кирка не крафтится', JSON.stringify(ironPick));
} else {
  ok('железная кирка скрафчена');

  const diamondSpot = await api(() => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 12;
    const y = Math.floor(p.position[1]);
    const z = Math.round(p.position[2]);
    a.fill(x - 1, y - 1, z - 1, x + 4, y + 2, z + 1, 0);
    a.fill(x, y, z, x, y, z, a.blockId('diamond_ore'));
    a.items.clear();
    return { x, y, z };
  });

  // Stone pickaxe first: it must break the ore and get nothing.
  await api(() => {
    const a = window.supergraph;
    if (a.equip('stone_pickaxe') < 0) { a.give('stone_pickaxe', 1); a.equip('stone_pickaxe'); }
    return a.inventory.selected;
  });
  const withStone = await aimAt(diamondSpot.x, diamondSpot.y, diamondSpot.z);
  if (withStone.ok) {
    const dug = await mineAimed(120);
    const got = await api(() => window.supergraph.droppedItems());
    if (dug && dug.gone && got.length > 0) {
      record('bad', 'алмаз выпадает от каменной кирки',
        `в эталоне нужна железная; выпало ${JSON.stringify(got)}`);
    } else if (dug && dug.gone) {
      ok('каменная кирка ломает алмазную руду впустую', `${dug.seconds.toFixed(1)} с`);
    }
  }

  const ironInHand = await api((d) => {
    const a = window.supergraph;
    a.fill(d.x, d.y, d.z, d.x, d.y, d.z, a.blockId('diamond_ore'));
    a.items.clear();
    return a.equip('iron_pickaxe');
  }, diamondSpot);
  if (ironInHand < 0) record('stop', 'железная кирка не попала в руку');
  const withIron = await aimAt(diamondSpot.x, diamondSpot.y, diamondSpot.z);
  if (!withIron.ok) {
    record('note', 'не навёлся на алмазную руду', JSON.stringify(withIron));
  } else {
    const dug = await mineAimed(120);
    const got = await api(() => window.supergraph.droppedItems());
    if (!dug || !dug.gone) {
      record('bad', 'железная кирка не берёт алмазную руду', JSON.stringify(dug));
    } else if (!got.some((d) => d.item === 'diamond')) {
      record('stop', 'алмазная руда не даёт алмаз железной киркой', JSON.stringify(got));
    } else {
      ok('железная кирка даёт алмаз', `${dug.seconds.toFixed(2)} с`);
    }
  }
}
await shoot('06b-smelt');
flushErrors();

/** Everything built for a test goes up here: empty sky, nothing to interfere. */
const SKY_RIG = 150;

// --- the world answering back --------------------------------------------
//
// Two things a player finds out by digging: sand falls, and a felled tree does
// not leave its canopy hanging in the sky.
await act('мир отвечает');

const sandRig = await api((floor) => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.round(p.position[0]);
  const z = Math.round(p.position[2]);
  a.fill(x - 3, floor - 4, z - 3, x + 3, floor + 8, z + 3, 0);
  a.fill(x, floor - 4, z, x, floor - 4, z, a.blockId('stone'));
  a.fill(x, floor, z, x, floor + 4, z, a.blockId('sand'));
  return { x, y: floor, z };
}, SKY_RIG);
await api(() => window.supergraph.tickReactions(20));
await waitFrames(2);
const sandNow = await api((s) => {
  const a = window.supergraph;
  const at = (dy) => a.blockName(a.world.getBlock(s.x, s.y + dy, s.z));
  return { above: [2, 3, 4].map(at), settled: [-3, -2, -1].map(at) };
}, sandRig);
if (sandNow.settled.some((n) => n !== 'sand')) {
  record('bad', 'песок не падает', JSON.stringify(sandNow));
} else if (sandNow.above.some((n) => n === 'sand')) {
  record('bad', 'песок упал не весь', JSON.stringify(sandNow));
} else {
  ok('песок падает и укладывается на опору', sandNow.settled.join(', '));
}

// A tree built for the purpose. One found in the world is never alone: a
// neighbour's canopy inside the same box keeps its own leaves, and the count
// then says the mechanic half-worked.
const treeRig = await api((floor) => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.round(p.position[0]) + 12;
  const z = Math.round(p.position[2]);
  const LOG = a.blockId('oak_log');
  const LEAF = a.blockId('oak_leaves');
  a.fill(x - 6, floor - 2, z - 6, x + 6, floor + 10, z + 6, 0);
  a.fill(x, floor, z, x, floor + 4, z, LOG);
  for (let dy = 2; dy <= 6; dy++) {
    const r = dy >= 5 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dz === 0 && dy <= 4) continue;
        a.fill(x + dx, floor + dy, z + dz, x + dx, floor + dy, z + dz, LEAF);
      }
    }
  }
  return { x, y: floor, z };
}, SKY_RIG);

const countLeaves = () => api((b) => {
  const a = window.supergraph;
  let n = 0;
  for (let dy = -2; dy <= 10; dy++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (a.blockName(a.world.getBlock(b.x + dx, b.y + dy, b.z + dz)) === 'oak_leaves') n++;
      }
    }
  }
  return n;
}, treeRig);

await api(() => window.supergraph.tickReactions(4));
const leavesBefore = await countLeaves();
// `fill`, not five `setBlock` calls: an edit drops its column out of `Lit` for
// the relight, and the next `setBlock` in the same tick is refused — four of
// the five logs would have stayed standing and held the canopy up.
await api((b) => window.supergraph.fill(b.x, b.y, b.z, b.x, b.y + 4, b.z, 0), treeRig);
await api(() => window.supergraph.items.clear());
await api(() => window.supergraph.tickReactions(40));
await waitFrames(2);
const leavesAfter = await countLeaves();

if (leavesBefore < 40) {
  record('note', 'дерево для проверки не построилось', `листвы ${leavesBefore}`);
} else if (leavesAfter > 0) {
  record('bad', 'листва не осыпается после вырубки',
    `осталось ${leavesAfter} из ${leavesBefore}`);
} else {
  const sticks = await api(() => window.supergraph.droppedItems().length);
  ok('листва осыпается после вырубки', `${leavesBefore} блоков, выпало ${sticks} предметов`);
}
flushErrors();

// --- the hand ------------------------------------------------------------
//
// Half the tactile feel of the reference is that your hand moves when you hit
// something. Checked through the frame the renderer is actually given, not by
// looking at a screenshot: what is drawn, and whether a swing starts.
await act('рука');

const emptyHand = await api(() => {
  const a = window.supergraph;
  // Make an empty slot rather than hoping for one: by this point in the run the
  // hotbar is full, and "no empty slot found" used to leave the pickaxe in hand
  // and report that an empty hand draws a pickaxe.
  let empty = a.inventory.slots.findIndex((s, i) => i < 9 && !s);
  if (empty < 0) {
    empty = 0;
    const displaced = a.inventory.get(0);
    a.inventory.set(0, null);
    if (displaced) a.inventory.add(displaced);
  }
  a.inventory.selected = empty;
  return a.hand();
});
if (emptyHand.drawn) {
  record('note', 'пустая рука что-то рисует', JSON.stringify(emptyHand));
} else {
  ok('пустая рука ничего не рисует');
}

await api(() => {
  const a = window.supergraph;
  a.give('cobblestone', 4);
  a.equip('cobblestone');
});
await waitFrames(2);
const blockHand = await api(() => window.supergraph.hand());
if (!blockHand.drawn || blockHand.sprite) {
  record('bad', 'блок в руке не рисуется кубом', JSON.stringify(blockHand));
} else {
  ok('блок в руке рисуется кубом', blockHand.item);
}

await api(() => {
  const a = window.supergraph;
  if (a.equip('stone_pickaxe') < 0) { a.give('stone_pickaxe', 1); a.equip('stone_pickaxe'); }
});
await waitFrames(2);
const toolHand = await api(() => window.supergraph.hand());
if (!toolHand.drawn || !toolHand.sprite) {
  record('bad', 'инструмент в руке не рисуется иконкой', JSON.stringify(toolHand));
} else {
  ok('инструмент в руке рисуется иконкой', toolHand.item);
}

// A swing has to start when the pick comes down, and finish on its own.
const swingRig = await api((floor) => {
  const a = window.supergraph;
  const p = a.player;
  const x = Math.round(p.position[0]) + 24;
  const z = Math.round(p.position[2]);
  a.fill(x - 1, floor - 1, z - 1, x + 4, floor + 2, z + 1, 0);
  a.fill(x, floor, z, x, floor, z, a.blockId('stone'));
  return { x, y: floor, z };
}, SKY_RIG);
const onSwingTarget = await aimAt(swingRig.x, swingRig.y, swingRig.z);
if (!onSwingTarget.ok) {
  record('note', 'не навёлся на блок для замаха', JSON.stringify(onSwingTarget));
} else {
  await api(() => window.supergraph.button(0, true));
  await waitFrames(1);
  const swinging = await api(() => window.supergraph.hand().swing);
  await api(() => window.supergraph.button(0, false));
  if (swinging >= 1) {
    record('bad', 'рука не замахивается при добыче', `swing ${swinging}`);
  } else {
    ok('рука замахивается при добыче', `swing ${swinging.toFixed(2)}`);
  }
  for (let i = 0; i < 12; i++) {
    await waitFrames(1);
    if (await api(() => window.supergraph.hand().swing) >= 1) break;
  }
  const settled = await api(() => window.supergraph.hand().swing);
  if (settled < 1) record('bad', 'замах не заканчивается', `swing ${settled}`);
  else ok('замах заканчивается сам');
}
await shoot('07-hand');
flushErrors();

// --- chests --------------------------------------------------------------
//
// Thirty-six slots fill up in one trip down a mine. Without somewhere to put
// the cobblestone the only way to make room is to throw it away, which is not
// a decision, it is an accident waiting to happen.
await act('сундук');

await api(() => window.supergraph.give('oak_planks', 8));
const chestCrafted = await craftIn([
  'oak_planks', 'oak_planks', 'oak_planks',
  'oak_planks', null, 'oak_planks',
  'oak_planks', 'oak_planks', 'oak_planks',
], 3);
if (!chestCrafted || chestCrafted.item !== 'chest') {
  record('stop', 'сундук не крафтится из досок', JSON.stringify(chestCrafted));
} else {
  ok('сундук скрафчен');

  const chestSpot = await api((floor) => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 20;
    const z = Math.round(p.position[2]);
    a.fill(x - 1, floor - 1, z - 1, x + 4, floor + 3, z + 1, 0);
    a.fill(x, floor, z, x, floor, z, a.blockId('stone'));
    return { x, y: floor, z };
  }, SKY_RIG);

  const inHandChest = await api(() => window.supergraph.equip('chest'));
  const onSpot = await aimAt(chestSpot.x, chestSpot.y, chestSpot.z);
  if (inHandChest < 0 || !onSpot.ok) {
    record('note', 'сундук некуда поставить', `${inHandChest} ${JSON.stringify(onSpot)}`);
  } else {
    await api(() => window.supergraph.button(2, true));
    await waitFrames(2);
    await api(() => window.supergraph.button(2, false));
    await waitFrames(2);
    const at = { x: chestSpot.x + 1, y: chestSpot.y, z: chestSpot.z };
    const placedChest = await api((c) => window.supergraph.blockName(
      window.supergraph.world.getBlock(c.x, c.y, c.z)), at);

    if (placedChest !== 'chest') {
      record('bad', 'сундук не встал', `на месте ${placedChest}`);
    } else {
      ok('сундук поставлен', `${at.x} ${at.y} ${at.z}`);

      // Put something in through the window, the way a player does: open it,
      // shift-click a stack out of the bag.
      const stored = await api((c) => {
        const a = window.supergraph;
        a.give('cobblestone', 30);
        a.openChest(c.x, c.y, c.z);
        const index = a.inventory.slots.findIndex((s) => s && a.blockName(s.id) === 'cobblestone');
        const el = index < 9
          ? document.querySelectorAll('#inventory .inv-hotbar-row .islot')[index]
          : document.querySelectorAll('#inventory .inv-grid:not(.inv-hotbar-row):not(.inv-chest) .islot')[index - 9];
        el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, shiftKey: true }));
        return { chest: a.chestState(c.x, c.y, c.z), bag: a.have('cobblestone') };
      }, at);

      if (!stored.chest || stored.chest.total < 30) {
        record('bad', 'shift-клик не кладёт стопку в сундук', JSON.stringify(stored));
      } else if (stored.bag !== 0) {
        record('bad', 'стопка положена в сундук, но осталась и в сумке',
          `в сумке ${stored.bag}`);
      } else {
        ok('shift-клик кладёт стопку в сундук', `${stored.chest.total} блоков`);
      }
      await shoot('08-chest');
      await api(() => window.supergraph.closeInventory());
      await waitFrames(1);

      // Closing must not empty it, and breaking it must give everything back.
      const kept = await api((c) => window.supergraph.chestState(c.x, c.y, c.z), at);
      if (!kept || kept.total < 30) {
        record('stop', 'сундук потерял содержимое при закрытии', JSON.stringify(kept));
      } else {
        ok('сундук держит содержимое', `${kept.total} блоков`);
      }

      await api(() => {
        const a = window.supergraph;
        a.items.clear();
        if (a.equip('stone_axe') < 0) { a.give('stone_axe', 1); a.equip('stone_axe'); }
      });
      const onChest = await aimAt(at.x, at.y, at.z);
      if (onChest.ok) {
        const broken = await mineAimed(80);
        const spilled = await api(() => window.supergraph.droppedItems());
        const cobble = spilled.filter((d) => d.item === 'cobblestone')
          .reduce((sum, d) => sum + d.count, 0);
        if (!broken || !broken.gone) {
          record('bad', 'сундук не ломается', JSON.stringify(broken));
        } else if (cobble < 30) {
          record('stop', 'сломанный сундук съел содержимое',
            `выпало ${cobble} булыжника из 30`);
        } else {
          ok('сломанный сундук отдаёт содержимое', `${cobble} булыжника`);
        }
      }
    }
  }
}
flushErrors();

// --- light underground ---------------------------------------------------
//
// A mine with no light is not a hard mine, it is a black screen. Torches are
// the only light a player can make, so this is the check that the game has a
// second half at all.
await act('свет');

await api(() => { window.supergraph.give('coal', 4); window.supergraph.give('stick', 4); });
const torches = await craftIn(['coal', null, 'stick', null], 2);
if (!torches || torches.item !== 'torch') {
  record('stop', 'факелы не крафтятся из угля и палки', JSON.stringify(torches));
} else {
  ok('факелы скрафчены', `${torches.count} шт. из одного угля`);

  const shaft = await api((floor) => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 16;
    const z = Math.round(p.position[2]);
    // A sealed room: no sky, so any light in it came from a torch.
    a.fill(x - 3, floor - 2, z - 3, x + 3, floor + 4, z + 3, a.blockId('stone'));
    a.fill(x - 1, floor, z - 1, x + 1, floor + 2, z + 1, 0);
    return { x, y: floor, z };
  }, SKY_RIG);
  await waitFrames(6);

  const before = await api((s) => {
    const packed = window.supergraph.world.store.getLight(s.x, s.y, s.z);
    return { sky: packed >> 4, block: packed & 15 };
  }, shaft);
  if (before.sky > 0 || before.block > 0) {
    record('note', 'комната для проверки света не запечатана', JSON.stringify(before));
  }

  await api((s) => {
    const a = window.supergraph;
    a.fill(s.x, s.y, s.z, s.x, s.y, s.z, a.blockId('torch'));
  }, shaft);
  await waitFrames(8);
  const after = await api((s) => {
    const a = window.supergraph;
    const packed = a.world.store.getLight(s.x + 1, s.y, s.z);
    return { sky: packed >> 4, block: packed & 15,
      here: a.blockName(a.world.getBlock(s.x, s.y, s.z)) };
  }, shaft);

  if (after.here !== 'torch') {
    record('bad', 'факел не встал', JSON.stringify(after));
  } else if (after.block < 10) {
    record('stop', 'факел не светит', `блочный свет рядом ${after.block} из 14`);
  } else {
    ok('факел освещает шахту', `было ${before.block}, стало ${after.block}`);
  }

  // And it comes back when broken — a torch you cannot pick up is a torch you
  // stop placing.
  const onTorch = await aimAt(shaft.x, shaft.y, shaft.z);
  if (onTorch.ok) {
    await api(() => window.supergraph.items.clear());
    const dug = await mineAimed(30);
    const got = await api(() => window.supergraph.droppedItems());
    if (!dug || !dug.gone) record('bad', 'факел не ломается', JSON.stringify(dug));
    else if (!got.some((d) => d.item === 'torch')) {
      record('bad', 'сломанный факел не возвращается', JSON.stringify(got));
    } else {
      ok('факел ломается мгновенно и возвращается', `${dug.seconds.toFixed(2)} с`);
    }
  }
}
flushErrors();

// --- damage and death ----------------------------------------------------
//
// Until there is a way to lose, height is scenery and lava is decoration.
await act('урон');

const vitals0 = await api(() => window.supergraph.vitals());
if (!vitals0 || vitals0.max !== 20) {
  record('stop', 'здоровья нет вовсе', JSON.stringify(vitals0));
} else {
  ok('здоровье есть', `${vitals0.health} из ${vitals0.max}`);

  // A twelve-block drop onto stone. The reference charges one half-heart per
  // block past the third, so this should cost about nine.
  // High above the terrain on purpose. Earlier versions built the shaft
  // wherever the player happened to be standing, and by this point in the run
  // that can be the sea floor: the pit floods, the fall lands in water, and
  // water cancels fall damage — so the test reported a broken mechanic when
  // what it had actually built was a swimming pool.
  const SKY = 150;
  const fell = await api((floor) => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]);
    const z = Math.round(p.position[2]);
    a.fill(x - 2, floor, z - 2, x + 2, floor + 24, z + 2, 0);
    a.fill(x - 2, floor - 1, z - 2, x + 2, floor - 1, z + 2, a.blockId('stone'));
    a.player.flying = false;
    a.player.health = 20;
    a.player.dead = false;
    a.teleport(x + 0.5, floor + 12, z + 0.5);
    return { x, y: floor, z };
  }, SKY);
  let landed = null;
  for (let i = 0; i < 60; i++) {
    await waitFrames(1);
    const s = await api(() => ({
      ...window.supergraph.vitals(),
      onGround: window.supergraph.player.onGround,
      y: window.supergraph.player.position[1],
    }));
    if (s.onGround && s.y < fell.y + 1.5) { landed = s; break; }
  }
  if (!landed) {
    record('note', 'падение не завершилось за отведённые кадры');
  } else if (landed.health >= 20) {
    record('bad', 'падение с двенадцати блоков не наносит урона',
      `здоровье ${landed.health}, ноги в ${landed.y.toFixed(1)}`);
  } else {
    ok('падение наносит урон',
      `с 12 блоков осталось ${landed.health} из 20 (в эталоне ~11)`);
  }

  // Lava is four half-hearts every half second, and it kills.
  const inLava = await api((floor) => {
    const a = window.supergraph;
    const p = a.player;
    const x = Math.round(p.position[0]) + 6;
    const z = Math.round(p.position[2]);
    a.fill(x - 1, floor - 1, z - 1, x + 1, floor + 3, z + 1, 0);
    a.fill(x - 1, floor - 2, z - 1, x + 1, floor - 2, z + 1, a.blockId('stone'));
    a.fill(x, floor - 1, z, x, floor - 1, z, a.blockId('lava'));
    a.player.health = 20;
    a.player.dead = false;
    a.player.flying = false;
    a.teleport(x + 0.5, floor - 0.6, z + 0.5);
    return { x, y: floor, z };
  }, SKY);
  let burned = null;
  for (let i = 0; i < 40; i++) {
    await waitFrames(1);
    const s = await api(() => window.supergraph.vitals());
    if (s.health < 20 || s.dead) { burned = s; break; }
  }
  if (!burned) {
    record('bad', 'лава не жжёт', JSON.stringify(inLava));
  } else {
    ok('лава наносит урон', `здоровье ${burned.health}`);
  }

  // And death: the bag spills, the panel comes up, respawn puts it back.
  const died = await api(() => {
    const a = window.supergraph;
    a.player.health = 20;
    a.player.dead = false;
    a.items.clear();
    a.give('cobblestone', 12);
    a.hurt(40, 'fall');
    return { vitals: a.vitals(), ground: a.droppedItems().length, bag: a.bag().length };
  });
  if (!died.vitals.dead || !died.vitals.deathPanel) {
    record('stop', 'смерти нет: здоровье кончилось, а игра продолжается',
      JSON.stringify(died));
  } else {
    ok('смерть показывает экран');
    if (died.bag > 0 || died.ground === 0) {
      record('bad', 'при смерти вещи не выпадают',
        `в сумке ${died.bag}, на земле ${died.ground}`);
    } else {
      ok('при смерти вещи выпадают', `${died.ground} стопок на земле`);
    }
    await shoot('09-death');

    const back = await api(() => window.supergraph.respawn());
    if (back.dead || back.health < 20) {
      record('stop', 'возрождение не работает', JSON.stringify(back));
    } else {
      ok('возрождение возвращает в мир', `здоровье ${back.health}`);
    }
  }
}
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
  await shoot('10-underwater');

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
await shoot('11-night');
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
    + `сид 424242, ${findings.length} замечаний, ${passes.length} проверок пройдено.`,
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

if (passes.length > 0) {
  lines.push('## Что прошло', '');
  let act = '';
  for (const p of passes) {
    if (p.act !== act) {
      act = p.act;
      lines.push('', `**${act}**`, '');
    }
    lines.push(`* ${p.text}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  lines.push('');
}

writeFileSync(`${OUT}/report.md`, lines.join('\n'));

console.log('');
console.log(`стоп: ${bySeverity('stop').length}   плохо: ${bySeverity('bad').length}   `
  + `нет механики: ${bySeverity('gap').length}`);
console.log(`отчёт: ${OUT}/report.md`);

await browser.close();

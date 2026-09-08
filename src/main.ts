/**
 * Entry point: boot sequence and the frame loop.
 */

import './ui/style.css';

import { createContext, WebGL2UnavailableError } from './render/gl.ts';
import { Renderer, ITEM_INSTANCE_FLOATS, type FrameState } from './render/renderer.ts';
import { World } from './world/world.ts';
import { WorldSave } from './world/persistence.ts';
import { Player } from './player/player.ts';
import { Input } from './core/input.ts';
import { AudioEngine } from './audio/audio.ts';
import { Hud, facingLabel } from './ui/hud.ts';
import { Inventory } from './game/inventory.ts';
import { ItemEntities } from './game/entities.ts';
import { Furnaces } from './game/smelting.ts';
import { WorldReactions } from './game/worldreact.ts';
import { dropsFor } from './game/drops.ts';
import { breakSeconds } from './game/mining.ts';
import { itemByName, itemDef, stack, type ItemStack } from './game/items.ts';
import { InventoryWindow } from './ui/inventory.ts';
import { buildIcons } from './ui/icons.ts';
import { buildItemInstances } from './render/itemInstances.ts';
import { matchRecipe } from './game/recipes.ts';
import {
  loadSettings, saveSettings, presetSettings, type PresetName, type Settings,
} from './core/settings.ts';
import { BIOME_FOG_DENSITY, BIOME_WATER_RGB } from './world/biomes.ts';
import { Block, BLOCKS } from './world/blocks.ts';
import { isWater } from './world/fluids.ts';
import { vec3, clamp } from './core/math.ts';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const loaderBar = document.getElementById('loader-bar') as HTMLElement;
const loaderLabel = document.getElementById('loader-label') as HTMLElement;
const playButton = document.getElementById('play') as HTMLButtonElement;

/**
 * The label stays hidden while things go well — the bar says everything a
 * loading screen needs to. It keeps receiving the text anyway, because the
 * smoke test reads it to find out what stage a failed boot died on.
 */
function setProgress(fraction: number, label: string): void {
  loaderBar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
  loaderLabel.textContent = label;
}

function fail(message: string): void {
  setProgress(1, '');
  loaderLabel.textContent = message;
  loaderLabel.style.color = '#e88';
  loaderLabel.hidden = false;
  playButton.disabled = true;
}

/** Yields to the browser so the loading bar actually paints. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function boot(): Promise<void> {
  let context;
  try {
    context = createContext(canvas);
  } catch (error) {
    fail(error instanceof WebGL2UnavailableError ? error.message : String(error));
    return;
  }

  const { gl, caps } = context;
  const stored = loadSettings();
  let settings: Settings = stored.settings;
  let preset: PresetName = stored.preset;

  setProgress(0.04, `GPU: ${caps.renderer}`);
  await nextFrame();

  // --- renderer ---
  let renderer: Renderer;
  try {
    renderer = new Renderer(gl, caps, settings);
  } catch (error) {
    fail(`Не удалось создать рендерер: ${String(error)}`);
    return;
  }

  setProgress(0.1, 'компиляция шейдеров…');
  await nextFrame();

  try {
    // KHR_parallel_shader_compile lets the driver link the whole set at once;
    // polling keeps the loading bar responsive while it does.
    let guard = 0;
    while (!renderer.pollPrograms() && guard++ < 600) {
      setProgress(0.1 + Math.min(guard / 600, 1) * 0.2, 'компиляция шейдеров…');
      await nextFrame();
    }
    renderer.pollPrograms();
  } catch (error) {
    fail(String(error));
    console.error(error);
    return;
  }

  setProgress(0.32, 'генерация материалов…');
  await nextFrame();

  try {
    await renderer.initResources((done, total, name) => {
      setProgress(0.32 + (done / total) * 0.28, `материал ${name} (${done}/${total})`);
    });
  } catch (error) {
    fail(String(error));
    console.error(error);
    return;
  }

  setProgress(0.62, 'создание мира…');
  await nextFrame();

  // --- world ---
  // `?seed=N` pins the world, which is what makes benchmark runs comparable:
  // without it every run lands somewhere different and the numbers move by
  // more than any optimisation does.
  const seedParam = new URLSearchParams(location.search).get('seed');
  const seed = seedParam !== null && Number.isFinite(Number(seedParam))
    ? Number(seedParam) >>> 0
    : Math.floor(Math.random() * 0x7fffffff);
  const workerCount = clamp((navigator.hardwareConcurrency ?? 4) - 1, 1, 6);
  const world = new World(seed, workerCount);
  world.setSink(renderer);

  // Before anything streams: a column that arrives with saved edits has to be
  // patched before it is lit, and that is only possible if the edits are
  // already in memory.
  // `?nosave` starts from the generated world every time and writes nothing
  // back. A scripted playthrough that resumes the previous run's save wakes up
  // inside whatever the previous run built — which is exactly what happened the
  // first time this was tried, and it looked like the input was broken.
  const noSave = new URLSearchParams(location.search).has('nosave');
  setProgress(0.63, 'загрузка сохранения…');
  if (!noSave) world.attachSave(await WorldSave.open(seed));

  /** Copies the streaming and detail-level settings into the world. */
  function applyWorldSettings(): void {
    world.renderDistance = settings.renderDistance;
    world.lodEnabled = settings.lodEnabled;
    world.lodNearChunks = settings.lodNearChunks;
    world.lodFarChunks = settings.lodFarChunks;
    world.giEnabled = settings.giEnabled;
  }
  applyWorldSettings();

  const input = new Input(canvas);
  const inventory = new Inventory();
  const player = new Player(world, input, inventory);
  const items = new ItemEntities();
  const furnaces = new Furnaces();

  // Sand that falls and leaves that rot: the world's own answer to being dug.
  const reactions = new WorldReactions(world, items);
  world.onBlockChanged = (x, y, z, previous, block) => {
    reactions.onBlockChanged(x, y, z, previous, block);
  };

  // Icons are drawn once, on a canvas, and used in two places: the DOM slots
  // and — as a texture array — the sprites of items lying on the ground.
  const icons = buildIcons(32);
  renderer.setItemIcons(icons.pixels, icons.size, icons.layers);

  // A world that has been visited resumes where it was left; a new one starts
  // at a spawn point the generator picks.
  const resumed = world.savedState;
  const spawn = resumed
    ? { x: resumed.x, y: resumed.y, z: resumed.z }
    : world.findSpawn();
  player.setPosition(spawn.x, spawn.y, spawn.z);
  if (resumed) {
    player.yaw = resumed.yaw;
    player.pitch = resumed.pitch;
    player.hotbarIndex = resumed.hotbar;
    inventory.load(resumed.inventory);
    furnaces.load(resumed.furnaces);
    renderer.sky.timeOfDay = resumed.time;
  }

  const audio = new AudioEngine();

  const hud = new Hud(settings, preset, inventory, icons, {
    onSettingsChange(next, nextPreset) {
      settings = next;
      preset = nextPreset;
      saveSettings(preset, settings);
      applyWorldSettings();
      renderer.applySettings(settings);
      audio.setVolume(settings.audioVolume);
      world.invalidateAtlases();
      resize();
    },
  });
  hud.setHotbarIndex(player.hotbarIndex);

  /** Throws a stack out in front of the player's eyes. */
  function dropIntoWorld(item: ItemStack): void {
    items.throwFrom(player.camera.position, player.camera.forward, item);
  }

  /**
   * Dying.
   *
   * Everything carried is spilled where it happened, as in the reference. That
   * is harsh, and it is also the only thing that makes a deep mine a decision
   * rather than a corridor: what is at stake is the trip, not the character.
   */
  function onDeath(): void {
    const causes: Record<string, string> = {
      fall: 'Падение с высоты',
      lava: 'Лава',
      cactus: 'Кактус',
      drown: 'Утонул',
      crush: 'Задохнулся в блоке',
      void: 'Бездна',
    };
    const cause = player.lastHurt ? causes[player.lastHurt.cause] : 'Смерть';

    inventoryWindow.hide();
    if (!input.synthetic) input.releaseLock();
    for (let i = 0; i < inventory.slots.length; i++) {
      const slot = inventory.get(i);
      if (!slot) continue;
      inventory.set(i, null);
      items.spawn(
        player.position[0], player.position[1] + 0.9, player.position[2], slot,
        (Math.random() - 0.5) * 2.5, 2.2, (Math.random() - 0.5) * 2.5,
        // Long enough that respawning next to the pile does not instantly
        // collect it, short enough that walking back does.
        3,
      );
    }

    hud.showDeath(cause, () => {
      hud.hideDeath();
      player.revive();
      const home = world.findSpawn();
      player.setPosition(home.x, home.y, home.z);
      // The spawn point is a column top, but the world may have changed since;
      // drop onto whatever is solid there now.
      for (let y = Math.min(home.y + 40, 190); y > 1; y--) {
        if (world.isSolidAt(Math.floor(home.x), y - 1, Math.floor(home.z))) {
          player.setPosition(home.x, y + 0.05, home.z);
          break;
        }
      }
      if (!input.synthetic) input.requestLock();
    });
  }

  const inventoryWindow = new InventoryWindow(inventory, icons, {
    onDrop: dropIntoWorld,
    onVisibility(open) {
      player.uiOpen = open;
      hud.setWindowOpen(open);
      // The world keeps running; only the pointer changes hands. Under
      // synthetic input there is no pointer to hand over, and asking for the
      // lock back would end a scripted run.
      if (input.synthetic) return;
      if (open) input.releaseLock(); else input.requestLock();
    },
  });

  // --- sizing ---
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(2, Math.round(window.innerWidth * dpr));
    const height = Math.max(2, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    renderer.resize(width, height);
  }
  resize();
  window.addEventListener('resize', resize);

  // --- preload the chunks around the spawn before showing the play button ---
  setProgress(0.68, 'генерация ландшафта…');

  const preloadTarget = 26;
  for (let i = 0; i < 400; i++) {
    world.update(spawn.x, spawn.z, 8);
    const stats = world.stats();
    const ready = stats.lit;
    setProgress(
      0.68 + Math.min(ready / preloadTarget, 1) * 0.3,
      `генерация ландшафта… ${ready}/${preloadTarget} чанков`,
    );
    if (ready >= preloadTarget) break;
    await nextFrame();
  }

  // Drop the player onto the ground now that the terrain around spawn exists.
  // A resumed player is already standing somewhere valid — possibly on a block
  // they built in mid-air, so dropping them would be wrong.
  for (let y = resumed ? -1 : Math.min(spawn.y + 40, 190); y > 1; y--) {
    if (world.isSolidAt(Math.floor(spawn.x), y - 1, Math.floor(spawn.z))) {
      player.setPosition(spawn.x, y + 0.05, spawn.z);
      break;
    }
  }

  setProgress(1, 'готово');
  playButton.disabled = false;

  // Debug handle: lets the smoke test (and the console) drive the game without
  // pointer lock, which headless Chrome cannot grant.
  (window as unknown as Record<string, unknown>).supergraph = {
    player, world, renderer, hud, audio, input,
    teleport(x: number, y: number, z: number) { player.setPosition(x, y, z); },
    look(yaw: number, pitch: number) { player.yaw = yaw; player.pitch = pitch; },
    /** 0..1 through the day; 0.25 sunrise, 0.5 noon, 0.75 sunset. */
    setTime(t: number, freeze = true) {
      renderer.sky.timeOfDay = t;
      renderer.sky.paused = freeze;
    },
    setWeather(rain: number, snow = 0) {
      renderer.sky.weather.rain = rain;
      renderer.sky.weather.wetness = rain;
      renderer.sky.weather.snow = snow;
    },
    /** Drops the player onto the highest solid block at their position. */
    ground() {
      const x = Math.floor(player.position[0]);
      const z = Math.floor(player.position[2]);
      for (let y = 190; y > 1; y--) {
        if (world.isSolidAt(x, y - 1, z)) {
          player.setPosition(player.position[0], y + 0.05, player.position[2]);
          return y;
        }
      }
      return -1;
    },
    /**
     * Points the camera relative to the sun's azimuth.
     * `offset` is in radians: 0 faces the sun, PI faces away.
     */
    faceSun(offset = 0, pitch = 0) {
      const d = renderer.sky.sunDirection;
      // forward = (-sin(yaw), *, -cos(yaw)), so a yaw that looks along the
      // sun's horizontal direction is atan2(-dx, -dz).
      const yaw = Math.atan2(-d[0], -d[2]) + offset;
      player.yaw = yaw;
      player.pitch = pitch;
      return yaw;
    },
    /**
     * Finds a scenic, above-water viewpoint near the player and stands there.
     *
     * Scores a modest rise over a summit: the highest point in range is usually
     * a mountaintop where everything below drowns in haze and there is nothing
     * nearby to give the frame scale.
     */
    findViewpoint(radius = 40) {
      let best: { x: number; z: number; y: number; score: number } | null = null;
      const cx = Math.floor(player.position[0]);
      const cz = Math.floor(player.position[2]);

      for (let i = 0; i < 400; i++) {
        const a = i * 2.399963;
        const r = Math.sqrt(i / 400) * radius;
        const x = cx + Math.round(Math.cos(a) * r);
        const z = cz + Math.round(Math.sin(a) * r);
        if (!world.isReadyAt(x, z)) continue;

        const h = world.store.getHeight(x, z);
        if (h < 0) continue;
        const top = world.getBlock(x, h, z);
        if (top === Block.Water) continue;

        // Needs real headroom and elbow room. A spot under a canopy or wedged
        // against a trunk fills the whole frame with one block face, and four
        // blocks of clearance is not enough to escape a tree.
        let clear = true;
        for (let dy = 1; dy <= 16 && clear; dy++) {
          if (world.isSolidAt(x, h + dy, z)) clear = false;
        }
        for (let dy = 1; dy <= 3 && clear; dy++) {
          for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
            if (world.isSolidAt(x + dx, h + dy, z + dz)) clear = false;
          }
        }
        if (!clear) continue;

        // Ideal is a low rise above the shoreline.
        const ideal = 74;
        let score = 100 - Math.abs(h - ideal) * 2.2;
        // Reward local relief: somewhere with a view rather than a flat plain.
        for (const [dx, dz] of [[12, 0], [-12, 0], [0, 12], [0, -12]] as const) {
          const n = world.store.getHeight(x + dx, z + dz);
          if (n >= 0) score += Math.min(Math.abs(n - h), 14) * 0.5;
        }
        if (!best || score > best.score) best = { x, z, y: h + 1, score };
      }

      if (!best) return null;
      player.setPosition(best.x + 0.5, best.y + 1.7, best.z + 0.5);
      return best;
    },
    stats: () => ({ world: world.stats(), render: renderer.stats }),
    /** Block id -> registry name, so a test can report what it actually found. */
    blockName: (id: number) => BLOCKS[id]?.name ?? `#${id}`,
    /**
     * Registry name -> block id.
     *
     * The other direction, and the more important one: a script that writes a
     * numeric id into `fill` is one inserted block away from building a
     * different world than it thinks. A test asking for lava by number got
     * flowing water, and reported that lava does not burn.
     */
    blockId: (name: string) => BLOCKS.find((b) => b.name === name)?.id ?? -1,
    /**
     * Seconds this block takes to break with what is currently in hand.
     *
     * So a test can ask instead of assuming. A check that "one click is not
     * enough" is true of stone and false of a flower, and the difference is
     * this number, not an opinion about mining.
     */
    breakSeconds: (block: number) => breakSeconds(block, inventory.held),

    // --- the game side ---
    //
    // Everything a playthrough needs to check that mining, dropping, carrying
    // and crafting actually happened, rather than that a frame was drawn.
    inventory,
    items,
    inventoryWindow,
    /** What is in the bag, as `{name, count, damage}` per filled slot. */
    bag: () => inventory.slots.map((slot, index) => (slot
      ? { index, name: itemDef(slot.id).label, id: slot.id,
          item: itemDef(slot.id).name, count: slot.count, damage: slot.damage }
      : null)).filter((s) => s !== null),
    /** How many of a named item are carried. */
    have: (name: string) => inventory.count(itemByName(name)),
    /** Puts items straight into the bag, for setting a test up. */
    give(name: string, count = 1) {
      const id = itemByName(name);
      if (id === 0) return -1;
      return count - inventory.addItem(id, count);
    },
    /** Registry name -> item id. */
    itemId: (name: string) => itemByName(name),
    /**
     * Puts a named item in hand, moving it to the hotbar if it is in storage.
     *
     * A script cannot click a slot, and "find the item and select it" written
     * out at every call site got the check `i < 9` wrong twice — which looked
     * like a broken pickaxe rather than a test holding the wrong tool.
     * Returns the hotbar slot, or -1.
     */
    equip(name: string) {
      const id = itemByName(name);
      if (id === 0) return -1;
      let index = inventory.slots.findIndex((s) => s && s.id === id);
      if (index < 0) return -1;
      if (index >= 9) {
        let target = inventory.slots.findIndex((s, i) => i < 9 && !s);
        if (target < 0) target = 0;
        const swap = inventory.get(target);
        inventory.set(target, inventory.get(index));
        inventory.set(index, swap);
        index = target;
      }
      inventory.selected = index;
      return index;
    },
    /** Puts an item on the ground at a spot, for looking at it. */
    dropAt(x: number, y: number, z: number, name: string, count = 1) {
      const id = itemByName(name);
      if (id === 0) return false;
      return !!items.spawn(x, y, z, stack(id, count), 0, 0, 0, 999);
    },
    /** Items lying on the ground. */
    droppedItems: () => items.list.map((e) => ({
      item: itemDef(e.item.id).name, count: e.item.count,
      x: e.x, y: e.y, z: e.z, age: e.age,
    })),
    /** Progress on the block being mined, 0..1, or -1 when not mining. */
    breakProgress: () => player.breaking?.progress ?? -1,
    /** Health in half-hearts, whether the player is dead, and from what. */
    vitals: () => ({
      health: player.health,
      max: player.maxHealth,
      dead: player.dead,
      cause: player.lastHurt?.cause ?? null,
      deathPanel: hud.deathVisible,
    }),
    /** Applies damage directly, for testing the consequences of it. */
    hurt(amount = 1, cause = 'fall') {
      player.hurt(amount, cause as Parameters<typeof player.hurt>[1]);
      if (player.dead && !hud.deathVisible) onDeath();
      return player.health;
    },
    /** Presses the respawn button. */
    respawn() {
      const button = document.getElementById('respawn') as HTMLButtonElement | null;
      button?.click();
      return { health: player.health, dead: player.dead };
    },
    /** Lays items into the open crafting grid by name; null clears a cell. */
    craftSet(cells: (string | null)[]) {
      for (let i = 0; i < inventoryWindow.grid.cells.length; i++) {
        const name = cells[i];
        inventoryWindow.grid.set(i, name ? stack(itemByName(name), 1) : null);
      }
      inventoryWindow.refresh(true);
      return inventoryWindow.grid.cells.map((c) => (c ? itemDef(c.id).name : null));
    },
    /** What the open grid currently makes, as a name, or null. */
    craftResult() {
      const result = matchRecipe(inventoryWindow.grid.cells, inventoryWindow.grid.size);
      return result ? { item: itemDef(result.id).name, count: result.count } : null;
    },
    furnaces,
    /**
     * Runs the furnaces forward by `seconds`, now.
     *
     * The same reason `tickFluids` exists: one ingot is ten seconds of game
     * time, and a headless browser on software rendering manages a few frames a
     * second — so a test that waits for real frames spends two minutes proving
     * that a furnace smelts, and gets written lenient instead of correct.
     */
    tickFurnaces(seconds = 1, step = 0.25) {
      for (let t = 0; t < seconds; t += step) {
        furnaces.update(step, (x, y, z, block) => {
          if (world.getBlock(x, y, z) !== block) world.setBlock(x, y, z, block);
        });
      }
      return furnaces.count;
    },
    /** Opens the furnace at these coordinates, as a right-click would. */
    openFurnace(x: number, y: number, z: number) {
      const block = world.getBlock(x, y, z);
      if (block !== Block.Furnace && block !== Block.FurnaceLit) return null;
      const state = furnaces.at(x, y, z);
      inventoryWindow.showFurnace(state);
      return state;
    },
    /** What one furnace holds, by item name, plus its two timers. */
    furnaceState(x: number, y: number, z: number) {
      const state = furnaces.peek(x, y, z);
      if (!state) return null;
      const name = (slot: { id: number; count: number } | null) =>
        (slot ? { item: itemDef(slot.id).name, count: slot.count } : null);
      return {
        input: name(state.input), fuel: name(state.fuel), output: name(state.output),
        burn: state.burn, cook: state.cook,
        lit: world.getBlock(x, y, z) === Block.FurnaceLit,
      };
    },
    /** Puts items into a furnace's slots, for setting a test up. */
    furnaceLoad(x: number, y: number, z: number, input: string | null, fuel: string | null) {
      const state = furnaces.at(x, y, z);
      state.input = input ? stack(itemByName(input), 8) : null;
      state.fuel = fuel ? stack(itemByName(fuel), 8) : null;
      return true;
    },
    /** Opens the bag (2) or a table (3) without needing a pointer. */
    openInventory(size = 2) {
      inventoryWindow.show(size, size === 3 ? 'Верстак' : 'Инвентарь');
      return inventoryWindow.isOpen;
    },
    closeInventory() { inventoryWindow.hide(); return inventoryWindow.isOpen; },
    /** True for water in any form, source or flow. */
    isWater,

    // --- playing from a script ---
    //
    // Everything above drives the *camera*. This drives the *game*: it starts
    // the simulation without pointer lock, which headless Chrome cannot grant,
    // and feeds synthetic keys and mouse deltas through the same path a person
    // uses. Without it nothing that needs time to pass — walking, digging,
    // water flowing, breath running out — can be exercised from outside.
    /** Starts the world running with script-driven input. */
    play() {
      overlay.hidden = true;
      hud.setPlaying(true);
      input.beginSynthetic();
      running = true;
      lastTime = performance.now();
      return true;
    },
    get running() { return running; },
    /**
     * Seconds of simulated time since the world started running.
     *
     * A script cannot measure movement against wall-clock time: the frame loop
     * clamps a long frame to a tenth of a second, so on a slow renderer the
     * game deliberately runs behind. Speed is distance over *this*.
     */
    get elapsed() { return elapsed; },
    /**
     * Runs the fluid simulation forward by `steps` ticks, now.
     *
     * The simulation is frame-paced, and a headless browser on software
     * rendering manages a few frames a second — so a spill that takes two
     * seconds in the game takes a minute to watch from a test, and a test that
     * slow gets written to be lenient instead of correct. This is the same
     * `update` the frame loop calls, with the same period.
     */
    tickFluids(steps = 1) {
      for (let i = 0; i < steps; i++) world.fluids.update(0.25);
      return world.fluids.pending;
    },
    /**
     * Runs falling blocks and leaf decay forward, now. Same reason as
     * `tickFluids`: these have a fixed clock, and a headless browser has no
     * frames to spare for waiting out three seconds of it.
     */
    tickReactions(steps = 1) {
      for (let i = 0; i < steps; i++) reactions.update(0.25);
      return reactions.pending;
    },
    /** Batched box fill, for building test rigs and structures from a script. */
    fill: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: number) =>
      world.fillBlocks(x0, y0, z0, x1, y1, z1, b),
    /** Holds or releases a key, by KeyboardEvent.code. */
    key: (code: string, down: boolean) => input.injectKey(code, down),
    /** Adds a mouse delta in pixels, exactly as pointer lock would report it. */
    mouse: (dx: number, dy: number) => input.injectMouse(dx, dy),
    /** Holds or releases a mouse button: 0 break, 2 place. */
    button: (index: number, down: boolean) => input.injectButton(index, down),
    /** Switches to a named quality preset, as the settings panel would. */
    setPreset(name: PresetName) {
      preset = name;
      settings = presetSettings(name);
      saveSettings(preset, settings);
      applyWorldSettings();
      renderer.applySettings(settings);
      world.invalidateAtlases();
      resize();
      return settings;
    },
    /** Overrides one setting without touching the rest, for A/B profiling. */
    setSetting(key: string, value: unknown) {
      (settings as unknown as Record<string, unknown>)[key] = value;
      applyWorldSettings();
      renderer.applySettings(settings);
      world.invalidateAtlases();
      resize();
    },
    /** Enables GPU timer queries and returns whether the driver supports them. */
    enableGpuProfiler(on = true) {
      renderer.profiler.enabled = on && renderer.profiler.supported;
      renderer.profiler.reset();
      return renderer.profiler.supported;
    },
    /**
     * 0 off, 1 AO, 2 skylight, 3 blocklight, 4 normal, 5 SSAO, 6 albedo,
     * 7 tint, 8 which pass painted the pixel, 9 texture AO, 10 height field,
     * 11 indirect light, 12 how far the light grid is trusted.
     */
    setDebugView(mode: number) { renderer.debugView = mode; },
    gpuTimings: () => renderer.profiler.snapshot(),
    cpuTimings: () => ({ ...cpu }),
    resetFrameTimes() { frameTimes.length = 0; },
    frameTimes: () => frameTimes.slice(),
    gpu: caps.renderer,
    spawn,
  };

  // --- frame loop ---
  const pointLights = new Float32Array(16 * 4);
  const underwaterTint = vec3(0.1, 0.29, 0.34);
  /** Instance stream for dropped items; sized for the entity cap. */
  const itemInstances = new Float32Array(256 * ITEM_INSTANCE_FLOATS);
  const frame: FrameState = {
    cameraPosition: player.camera.position,
    cameraForward: player.camera.forward,
    cameraUp: player.camera.up,
    time: 0,
    deltaTime: 0,
    selection: null,
    underwater: false,
    underwaterTint,
    underwaterDepth: 0,
    breath: 1,
    pointLights,
    pointLightCount: 0,
    biomeFog: 1,
    items: itemInstances,
    itemCubes: 0,
    itemSprites: 0,
    breaking: null,
  };

  let running = false;
  let lastTime = performance.now();
  let elapsed = 0;
  let lightRefreshTimer = 0;

  /** Last serialised bag, and the version it was made from. See `tick`. */
  let savedInventory: number[] = inventory.serialize();
  let savedInventoryVersion = inventory.version;
  let savedFurnaces: number[] = furnaces.serialize();
  let furnaceSaveTimer = 4;

  /** Rolling frame times in milliseconds, for the benchmark script. */
  const frameTimes: number[] = [];

  /**
   * Smoothed CPU cost of each phase of the loop.
   *
   * The GPU profiler accounted for only half the frame; the rest is either main
   * thread work or a stall waiting on the driver, and those need separating
   * before anything can be done about them.
   */
  const cpu = { world: 0, render: 0, pick: 0, lights: 0, hud: 0 };
  const accumulate = (key: keyof typeof cpu, ms: number): void => {
    cpu[key] = cpu[key] * 0.9 + ms * 0.1;
  };

  playButton.addEventListener('click', () => {
    overlay.hidden = true;
    hud.setPlaying(true);
    input.requestLock();
    running = true;
    lastTime = performance.now();
    // A browser will not start an audio context outside a user gesture, and
    // this click is the only one the game is guaranteed to get.
    void audio.start(settings.audioVolume);
  });

  // The two moments a browser gives to write something down: the tab going
  // away for good, and the tab going into the background — which on a phone is
  // the same thing, because it may never come back.
  window.addEventListener('pagehide', () => { void world.flushSave(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void world.flushSave();
  });

  document.addEventListener('pointerlockchange', () => {
    // Losing the pointer to the inventory window — or to the death panel — is
    // not the player walking away from the game, and must not put up the pause
    // overlay on top of them.
    if (!input.locked && running && !inventoryWindow.isOpen && !hud.deathVisible) {
      overlay.hidden = false;
      playButton.textContent = 'Продолжить';
      hud.setPlaying(false);
      running = false;
      void audio.suspend();
    }
  });

  /**
   * Footsteps, landings and ambience.
   *
   * All of it is derived from state the engine already keeps: the block under
   * the player's feet, the same wetness the shaders use to darken the ground,
   * the same wind value that bends the grass, and the baked skylight at head
   * height — which is what tells the difference between standing in a field
   * and standing in a cave without asking any new question of the world.
   */
  function updateAudio(dt: number, previousX: number, previousZ: number): void {
    if (!audio.running) return;

    const px = player.position[0];
    const py = player.position[1];
    const pz = player.position[2];
    const feetX = Math.floor(px);
    const feetZ = Math.floor(pz);

    const ground = world.getBlock(feetX, Math.floor(py - 0.05), feetZ);
    const wetness = renderer.sky.weather.wetness;

    const impact = player.takeLandingImpact();
    if (impact > 0) {
      audio.land(impact, ground, wetness);
    } else if (player.onGround && !player.flying) {
      audio.walk(Math.hypot(px - previousX, pz - previousZ), ground, wetness);
    }

    const eye = player.camera.position;
    const head = world.getBlock(
      Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]),
    );
    const light = world.store.getLight(feetX, Math.floor(py) + 1, feetZ);

    audio.update(dt, {
      rain: renderer.sky.weather.rain,
      wind: renderer.sky.weather.wind,
      skyVisibility: (light >> 4) / 15,
      underwater: head === Block.Water,
    });
  }

  function tick(now: number): void {
    requestAnimationFrame(tick);

    // Clamp dt so a tab switch or a long GC pause cannot teleport the player.
    const rawDelta = (now - lastTime) / 1000;
    const dt = clamp(rawDelta, 0, 0.1);
    lastTime = now;
    hud.recordFrame(rawDelta * 1000);
    frameTimes.push(rawDelta * 1000);
    if (frameTimes.length > 3000) frameTimes.shift();

    if (input.wasPressed('F3')) hud.toggleStats();
    if (input.wasPressed('F4')) hud.toggleSettings();

    if (running) {
      // E opens the bag with its own 2×2 grid, and closes whatever is open —
      // including a crafting table's 3×3.
      if (input.wasPressed('KeyE')) inventoryWindow.toggle(2, 'Инвентарь');
      if (input.wasPressed('Escape') && inventoryWindow.isOpen) inventoryWindow.hide();
      // Q throws one; with control held, the whole stack. Nothing else in the
      // game destroys items, so this is the only way to make room.
      if (input.wasPressed('KeyQ') && !inventoryWindow.isOpen) {
        const held = inventory.held;
        if (held) {
          const count = input.isDown('ControlLeft') ? held.count : 1;
          const thrown = inventory.take(inventory.selected, count);
          if (thrown) dropIntoWorld(thrown);
        }
      }
    }

    // The player is updated even while paused, with a zero timestep. Movement
    // integrates nothing, but the camera basis is still rebuilt — so the world
    // stays visible behind the pause overlay instead of the view snapping back
    // to the origin.
    elapsed += running ? dt : 0;
    const beforeX = player.position[0];
    const beforeZ = player.position[2];
    player.update(running ? dt : 0, settings.fovDegrees);
    if (running) {
      const event = player.interact(dt);
      if (event) {
        lightRefreshTimer = 0;
        if (event.kind === 'break') {
          audio.dig(event.block);
          // The block becomes items on the ground, and the swing wears the
          // tool. Both depend on what was in hand *at the moment it broke*, so
          // the drops are rolled before the tool is damaged and possibly
          // destroyed.
          const held = inventory.held;
          items.spawnFromBlock(event.x, event.y, event.z, dropsFor(event.block, held));
          // A broken container gives back what was inside it. Anything else is
          // a way to lose a stack of iron by mistake.
          if (event.block === Block.Furnace || event.block === Block.FurnaceLit) {
            const inside = furnaces.remove(event.x, event.y, event.z);
            if (inside.length > 0) items.spawnFromBlock(event.x, event.y, event.z, inside);
          }
          if (inventory.damageHeld(1)) audio.dig(event.block);
        } else if (event.kind === 'place') {
          audio.place(event.block);
        } else if (event.kind === 'use') {
          if (event.block === Block.CraftingTable) {
            inventoryWindow.show(3, 'Верстак');
          } else if (event.block === Block.Furnace || event.block === Block.FurnaceLit) {
            inventoryWindow.showFurnace(furnaces.at(event.x, event.y, event.z));
          }
        }
      }

      const picked = items.update(
        dt, world, inventory,
        player.position[0], player.position[1], player.position[2],
      );
      if (picked > 0) audio.pickup();

      // Furnaces run whether or not anyone is watching — that is what makes
      // leaving one loaded and going back to mining worth doing.
      furnaces.update(dt, (x, y, z, block) => {
        if (world.getBlock(x, y, z) === block) return;
        world.setBlock(x, y, z, block);
        lightRefreshTimer = 0;
      });

      if (player.lastHurt) {
        hud.showHurt();
        audio.hurt();
      }
      if (player.dead && !hud.deathVisible) onDeath();

      hud.setHotbarIndex(player.hotbarIndex);
      updateAudio(dt, beforeX, beforeZ);
    }
    hud.updateHotbar(dt);
    hud.updateHealth(player.health, dt);
    inventoryWindow.refresh();

    renderer.sky.update(running ? dt : 0);

    // Streaming gets a slice of the frame; the budget only bites on the
    // single-threaded fallback path.
    let mark = performance.now();
    world.update(player.position[0], player.position[2], world.usingWorkers ? 1 : 5);
    world.refreshAtlases();
    world.updateIndirectLight(player.position[0], player.position[2], dt);
    // The bag is only serialised when it changed; the same array is handed over
    // on every other frame so the save layer can tell by reference alone.
    if (inventory.version !== savedInventoryVersion) {
      savedInventoryVersion = inventory.version;
      savedInventory = inventory.serialize();
    }
    // Furnaces have a burn timer, so there is no version to compare — they
    // change every frame one of them is lit. Re-read them on a slow clock
    // instead: losing four seconds of a burn to a crash is nothing, and
    // serialising them sixty times a second for that is absurd.
    furnaceSaveTimer -= dt;
    if (furnaceSaveTimer <= 0) {
      furnaceSaveTimer = 4;
      const next = furnaces.serialize();
      if (next.length > 0 || savedFurnaces.length > 0) savedFurnaces = next;
    }
    world.recordPlayerState({
      x: player.position[0], y: player.position[1], z: player.position[2],
      yaw: player.yaw, pitch: player.pitch,
      time: renderer.sky.timeOfDay, hotbar: player.hotbarIndex,
      inventory: savedInventory,
      furnaces: savedFurnaces,
    });
    world.updateSave(dt);
    // Fluids tick on their own clock inside; passing dt every frame is what
    // lets them run at a fixed rate regardless of frame rate. Falling blocks
    // and rotting leaves keep their own clock the same way.
    if (running) {
      world.fluids.update(dt);
      reactions.update(dt);
    }
    accumulate('world', performance.now() - mark);

    // Nearby emissive blocks change slowly; rescanning every frame would be
    // the most expensive thing in the loop for no visible gain.
    lightRefreshTimer -= dt;
    if (lightRefreshTimer <= 0) {
      lightRefreshTimer = 0.25;
      mark = performance.now();
      frame.pointLightCount = world.collectNearbyLights(
        player.position[0], player.position[1], player.position[2], 16, pointLights,
      );
      accumulate('lights', performance.now() - mark);
    }

    mark = performance.now();
    const hit = player.pick();
    frame.selection = hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
    accumulate('pick', performance.now() - mark);

    const biome = world.store.getBiome(
      Math.floor(player.position[0]), Math.floor(player.position[2]),
    );
    frame.biomeFog = BIOME_FOG_DENSITY[biome] || 1;
    frame.underwater = player.headUnderwater;
    frame.underwaterDepth = player.submersion;
    frame.breath = player.breath;
    hud.updateBreath(player.breath);
    underwaterTint[0] = BIOME_WATER_RGB[biome * 3];
    underwaterTint[1] = BIOME_WATER_RGB[biome * 3 + 1];
    underwaterTint[2] = BIOME_WATER_RGB[biome * 3 + 2];

    frame.time = elapsed;
    frame.deltaTime = dt;
    frame.breaking = player.breaking;

    const instances = buildItemInstances(items.list, world, icons, itemInstances);
    frame.itemCubes = instances.cubes;
    frame.itemSprites = instances.sprites;

    mark = performance.now();
    renderer.render(frame);
    accumulate('render', performance.now() - mark);

    mark = performance.now();
    hud.updateStats({
      now,
      position: player.position,
      biome,
      clock: renderer.sky.clockString(),
      rain: renderer.sky.weather.rain,
      wind: renderer.sky.weather.wind,
      world: world.stats(),
      render: renderer.stats,
      renderer: caps.renderer,
      facing: facingLabel(player.yaw),
    });
    accumulate('hud', performance.now() - mark);

    input.endFrame();
  }

  requestAnimationFrame(tick);
}

void boot().catch((error) => {
  console.error(error);
  fail(String(error));
});

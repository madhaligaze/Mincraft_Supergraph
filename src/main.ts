/**
 * Entry point: boot sequence and the frame loop.
 */

import './ui/style.css';

import { createContext, WebGL2UnavailableError } from './render/gl.ts';
import { Renderer, type FrameState } from './render/renderer.ts';
import { World } from './world/world.ts';
import { WorldSave } from './world/persistence.ts';
import { Player } from './player/player.ts';
import { Input } from './core/input.ts';
import { AudioEngine } from './audio/audio.ts';
import { Hud, facingLabel } from './ui/hud.ts';
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
  setProgress(0.63, 'загрузка сохранения…');
  world.attachSave(await WorldSave.open(seed));

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
  const player = new Player(world, input);

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
    renderer.sky.timeOfDay = resumed.time;
  }

  const audio = new AudioEngine();

  const hud = new Hud(settings, preset, {
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
    player, world, renderer, hud, audio,
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
  };

  let running = false;
  let lastTime = performance.now();
  let elapsed = 0;
  let lightRefreshTimer = 0;

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
    if (!input.locked && running) {
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

    // The player is updated even while paused, with a zero timestep. Movement
    // integrates nothing, but the camera basis is still rebuilt — so the world
    // stays visible behind the pause overlay instead of the view snapping back
    // to the origin.
    elapsed += running ? dt : 0;
    const beforeX = player.position[0];
    const beforeZ = player.position[2];
    player.update(running ? dt : 0, settings.fovDegrees);
    if (running) {
      const event = player.interact();
      if (event) {
        lightRefreshTimer = 0;
        if (event.kind === 'break') audio.dig(event.block);
        else audio.place(event.block);
      }
      hud.setHotbarIndex(player.hotbarIndex);
      updateAudio(dt, beforeX, beforeZ);
    }

    renderer.sky.update(running ? dt : 0);

    // Streaming gets a slice of the frame; the budget only bites on the
    // single-threaded fallback path.
    let mark = performance.now();
    world.update(player.position[0], player.position[2], world.usingWorkers ? 1 : 5);
    world.refreshAtlases();
    world.updateIndirectLight(player.position[0], player.position[2], dt);
    world.recordPlayerState({
      x: player.position[0], y: player.position[1], z: player.position[2],
      yaw: player.yaw, pitch: player.pitch,
      time: renderer.sky.timeOfDay, hotbar: player.hotbarIndex,
    });
    world.updateSave(dt);
    // Fluids tick on their own clock inside; passing dt every frame is what
    // lets them run at a fixed rate regardless of frame rate.
    if (running) world.fluids.update(dt);
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

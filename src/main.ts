/**
 * Entry point: boot sequence and the frame loop.
 */

import './ui/style.css';

import { createContext, WebGL2UnavailableError } from './render/gl.ts';
import { Renderer, type FrameState } from './render/renderer.ts';
import { World } from './world/world.ts';
import { Player } from './player/player.ts';
import { Input } from './core/input.ts';
import { Hud, facingLabel } from './ui/hud.ts';
import {
  loadSettings, saveSettings, presetSettings, type PresetName, type Settings,
} from './core/settings.ts';
import { BIOME_FOG_DENSITY, BIOME_WATER_RGB } from './world/biomes.ts';
import { Block } from './world/blocks.ts';
import { vec3, clamp } from './core/math.ts';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const loaderBar = document.getElementById('loader-bar') as HTMLElement;
const loaderLabel = document.getElementById('loader-label') as HTMLElement;
const playButton = document.getElementById('play') as HTMLButtonElement;

function setProgress(fraction: number, label: string): void {
  loaderBar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
  loaderLabel.textContent = label;
}

function fail(message: string): void {
  setProgress(1, '');
  loaderLabel.textContent = message;
  loaderLabel.style.color = '#e88';
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
  world.renderDistance = settings.renderDistance;
  world.setSink(renderer);

  const input = new Input(canvas);
  const player = new Player(world, input);

  const spawn = world.findSpawn();
  player.setPosition(spawn.x, spawn.y, spawn.z);

  const hud = new Hud(settings, preset, {
    onSettingsChange(next, nextPreset) {
      settings = next;
      preset = nextPreset;
      saveSettings(preset, settings);
      world.renderDistance = settings.renderDistance;
      renderer.applySettings(settings);
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
  for (let y = Math.min(spawn.y + 40, 190); y > 1; y--) {
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
    player, world, renderer, hud,
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
    /** Switches to a named quality preset, as the settings panel would. */
    setPreset(name: PresetName) {
      preset = name;
      settings = presetSettings(name);
      saveSettings(preset, settings);
      world.renderDistance = settings.renderDistance;
      renderer.applySettings(settings);
      world.invalidateAtlases();
      resize();
      return settings;
    },
    /** Overrides one setting without touching the rest, for A/B profiling. */
    setSetting(key: string, value: unknown) {
      (settings as unknown as Record<string, unknown>)[key] = value;
      world.renderDistance = settings.renderDistance;
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
    /** 0 off, 1 AO, 2 skylight, 3 blocklight, 4 normal, 5 SSAO, 6 albedo, 7 tint. */
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
  });

  document.addEventListener('pointerlockchange', () => {
    if (!input.locked && running) {
      overlay.hidden = false;
      playButton.textContent = 'Продолжить';
      hud.setPlaying(false);
      running = false;
    }
  });

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
    player.update(running ? dt : 0, settings.fovDegrees);
    if (running) {
      if (player.interact()) lightRefreshTimer = 0;
      hud.setHotbarIndex(player.hotbarIndex);
    }

    renderer.sky.update(running ? dt : 0);

    // Streaming gets a slice of the frame; the budget only bites on the
    // single-threaded fallback path.
    let mark = performance.now();
    world.update(player.position[0], player.position[2], world.usingWorkers ? 1 : 5);
    world.refreshAtlases();
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

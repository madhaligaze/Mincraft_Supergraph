/**
 * Quality settings.
 *
 * Every field here is a knob that costs measurable frame time on an Intel
 * UHD 620. The presets are ordered so that `low` is expected to hold 60 fps at
 * 1280x720 on that part, and `ultra` is the "screenshot" tier.
 */

export type PresetName = 'low' | 'medium' | 'high' | 'ultra';

export type CloudMode = 'off' | 'planar' | 'volumetric';

export interface Settings {
  /** Chunks of horizontal view distance (1 chunk = 32 blocks). */
  renderDistance: number;

  /** Mesh distant chunks at a coarser decimation. */
  lodEnabled: boolean;
  /** Beyond this many chunks a section is meshed at two blocks per cell. */
  lodNearChunks: number;
  /** Beyond this many chunks, at four. */
  lodFarChunks: number;
  /** Backbuffer scale. The single strongest perf lever on an iGPU. */
  resolutionScale: number;
  fovDegrees: number;

  // Shadows
  shadowsEnabled: boolean;
  shadowCascades: number;
  shadowMapSize: number;
  /** How far the last cascade reaches, in blocks. */
  shadowDistance: number;
  /** 1 = 3x3 PCF, 2 = 5x5 rotated Poisson, 3 = 5x5 + normal-offset slope bias. */
  shadowFilter: number;

  // Ambient occlusion (screen space, on top of the baked per-vertex AO)
  ssaoEnabled: boolean;
  /** Fraction of the render target the AO buffer runs at. */
  ssaoScale: number;
  ssaoSamples: number;

  // Sky and atmosphere
  /** Raymarch steps for the per-frame sky-view LUT. */
  skyViewSteps: number;
  aerialPerspective: boolean;

  // Clouds
  cloudMode: CloudMode;
  cloudSteps: number;
  cloudScale: number;

  // Water
  waterReflections: boolean;
  /** Screen-space reflection ray steps; 0 falls back to sky-only reflection. */
  ssrSteps: number;
  waterRefraction: boolean;

  // Vegetation
  grassEnabled: boolean;
  /** Radius in blocks within which grass blades are instanced. */
  grassDistance: number;
  grassDensity: number;

  // Post processing
  taaEnabled: boolean;
  bloomEnabled: boolean;
  bloomStrength: number;
  motionBlur: boolean;
  /** 0 = off. Applied as a mild lens effect, not a gameplay blur. */
  chromaticAberration: number;
  vignette: number;
  filmGrain: number;
  exposure: number;

  // World
  /** Texture tile resolution for the procedurally generated material array. */
  textureResolution: number;
  anisotropy: number;
}

const BASE: Settings = {
  renderDistance: 8,
  lodEnabled: true,
  lodNearChunks: 5,
  lodFarChunks: 7,
  resolutionScale: 1.0,
  fovDegrees: 75,

  shadowsEnabled: true,
  shadowCascades: 3,
  shadowMapSize: 1024,
  shadowDistance: 160,
  shadowFilter: 2,

  ssaoEnabled: true,
  ssaoScale: 0.5,
  ssaoSamples: 12,

  skyViewSteps: 24,
  aerialPerspective: true,

  cloudMode: 'volumetric',
  cloudSteps: 32,
  cloudScale: 0.25,

  waterReflections: true,
  ssrSteps: 24,
  waterRefraction: true,

  grassEnabled: true,
  grassDistance: 48,
  /** Multiplier on blades per block; 1.0 is six. */
  grassDensity: 1.4,

  taaEnabled: true,
  bloomEnabled: true,
  bloomStrength: 0.05,
  motionBlur: false,
  chromaticAberration: 0.15,
  vignette: 0.35,
  filmGrain: 0.02,
  exposure: 1.0,

  textureResolution: 128,
  anisotropy: 4,
};

const OVERRIDES: Record<PresetName, Partial<Settings>> = {
  low: {
    renderDistance: 5,
    lodNearChunks: 3,
    lodFarChunks: 4,
    resolutionScale: 0.7,
    shadowCascades: 2,
    shadowMapSize: 1024,
    shadowDistance: 72,
    shadowFilter: 1,
    ssaoEnabled: false,
    skyViewSteps: 12,
    aerialPerspective: false,
    cloudMode: 'planar',
    cloudSteps: 0,
    waterReflections: false,
    ssrSteps: 0,
    waterRefraction: false,
    grassDistance: 24,
    grassDensity: 0.7,
    taaEnabled: true,
    bloomEnabled: false,
    chromaticAberration: 0,
    filmGrain: 0,
    textureResolution: 64,
    anisotropy: 1,
  },
  medium: {
    renderDistance: 7,
    lodNearChunks: 4,
    lodFarChunks: 6,
    resolutionScale: 0.85,
    shadowCascades: 3,
    shadowMapSize: 1024,
    shadowDistance: 128,
    shadowFilter: 2,
    ssaoScale: 0.5,
    ssaoSamples: 8,
    skyViewSteps: 16,
    cloudMode: 'volumetric',
    cloudSteps: 20,
    cloudScale: 0.25,
    ssrSteps: 12,
    grassDistance: 36,
    grassDensity: 1.0,
    textureResolution: 128,
    anisotropy: 4,
  },
  high: {
    // BASE is already the "high" tier.
  },
  ultra: {
    renderDistance: 12,
    lodNearChunks: 7,
    lodFarChunks: 10,
    resolutionScale: 1.0,
    shadowCascades: 4,
    shadowMapSize: 2048,
    shadowDistance: 256,
    shadowFilter: 3,
    ssaoScale: 1.0,
    ssaoSamples: 16,
    skyViewSteps: 40,
    cloudSteps: 64,
    cloudScale: 0.5,
    ssrSteps: 48,
    grassDistance: 64,
    grassDensity: 2.0,
    bloomStrength: 0.06,
    textureResolution: 256,
    anisotropy: 8,
  },
};

export function presetSettings(name: PresetName): Settings {
  return { ...BASE, ...OVERRIDES[name] };
}

const STORAGE_KEY = 'supergraph.settings.v1';

export function loadSettings(): { preset: PresetName; settings: Settings } {
  const fallback = { preset: 'medium' as PresetName, settings: presetSettings('medium') };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { preset?: PresetName; settings?: Partial<Settings> };
    const preset = parsed.preset ?? 'medium';
    // Merge over the preset so settings added in a later version get a default
    // instead of coming back undefined.
    return { preset, settings: { ...presetSettings(preset), ...(parsed.settings ?? {}) } };
  } catch {
    return fallback;
  }
}

export function saveSettings(preset: PresetName, settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, settings }));
  } catch {
    // Private-mode browsers throw on write; losing the preference is harmless.
  }
}

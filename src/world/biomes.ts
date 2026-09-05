/**
 * Biome table and climate classification.
 *
 * Biomes are selected from continuous climate fields rather than from a Voronoi
 * region map, so neighbouring biomes blend along real gradients. The colours
 * below are sampled per-vertex by the mesher and blended over a 3-block radius,
 * which is what removes the hard colour seam classic voxel games show at biome
 * borders.
 */

import { Block } from './blocks.ts';

export const enum Biome {
  DeepOcean = 0,
  Ocean,
  Beach,
  River,
  Plains,
  Meadow,
  Forest,
  BirchForest,
  DarkForest,
  Taiga,
  SnowyTaiga,
  SnowyPlains,
  Desert,
  Savanna,
  Badlands,
  Swamp,
  StonyShore,
  Highlands,
  Mountains,
  SnowyPeaks,
  Count,
}

export type TreeKind = 'none' | 'oak' | 'birch' | 'spruce' | 'tallSpruce' | 'darkOak' | 'acacia' | 'swampOak' | 'cactus';

export interface BiomeDef {
  id: Biome;
  name: string;
  /** Top block above sea level. */
  surface: Block;
  /** The 3-4 blocks under the surface. */
  subsurface: Block;
  /** Top block when the column is underwater. */
  underwater: Block;
  /** sRGB grass tint, 0..1. */
  grassColor: readonly [number, number, number];
  /** sRGB foliage (leaf) tint, 0..1. */
  foliageColor: readonly [number, number, number];
  /** Linear water absorption tint. */
  waterColor: readonly [number, number, number];
  tree: TreeKind;
  /** Expected trees per 32x32 chunk. */
  treeDensity: number;
  /** 0..1 chance per surface block. */
  grassDensity: number;
  flowerDensity: number;
  /** Snow layer on top when true. */
  snowy: boolean;
  /** Multiplier on the fog density in this biome. */
  fogDensity: number;
}

function d(def: BiomeDef): BiomeDef {
  return def;
}

const DEFS: BiomeDef[] = [];
const add = (def: BiomeDef): void => {
  DEFS[def.id] = def;
};

// Colours are chosen so that a single directional sun at golden hour produces
// the warm-green look of the reference screenshots without any post-process
// hue grading: the grass is already slightly desaturated and blue-shifted in
// shadow, and the sun does the warming.
const WATER_TEMPERATE = [0.10, 0.29, 0.34] as const;
const WATER_COLD = [0.13, 0.30, 0.38] as const;
const WATER_WARM = [0.09, 0.34, 0.36] as const;
const WATER_SWAMP = [0.19, 0.24, 0.14] as const;

add(d({
  id: Biome.DeepOcean, name: 'Глубокий океан',
  surface: Block.Gravel, subsurface: Block.Stone, underwater: Block.Gravel,
  grassColor: [0.44, 0.66, 0.35], foliageColor: [0.34, 0.60, 0.24], waterColor: WATER_COLD,
  tree: 'none', treeDensity: 0, grassDensity: 0, flowerDensity: 0, snowy: false, fogDensity: 1.0,
}));

add(d({
  id: Biome.Ocean, name: 'Океан',
  surface: Block.Sand, subsurface: Block.Sand, underwater: Block.Sand,
  grassColor: [0.44, 0.66, 0.35], foliageColor: [0.34, 0.60, 0.24], waterColor: WATER_TEMPERATE,
  tree: 'none', treeDensity: 0, grassDensity: 0, flowerDensity: 0, snowy: false, fogDensity: 1.0,
}));

add(d({
  id: Biome.Beach, name: 'Пляж',
  surface: Block.Sand, subsurface: Block.Sand, underwater: Block.Sand,
  grassColor: [0.50, 0.69, 0.36], foliageColor: [0.40, 0.63, 0.26], waterColor: WATER_TEMPERATE,
  tree: 'none', treeDensity: 0, grassDensity: 0.02, flowerDensity: 0, snowy: false, fogDensity: 0.9,
}));

add(d({
  id: Biome.River, name: 'Река',
  surface: Block.Sand, subsurface: Block.Clay, underwater: Block.Clay,
  grassColor: [0.44, 0.70, 0.33], foliageColor: [0.34, 0.63, 0.23], waterColor: WATER_TEMPERATE,
  tree: 'none', treeDensity: 0, grassDensity: 0.05, flowerDensity: 0.01, snowy: false, fogDensity: 1.1,
}));

add(d({
  id: Biome.Plains, name: 'Равнина',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.55, 0.74, 0.34], foliageColor: [0.42, 0.67, 0.25], waterColor: WATER_TEMPERATE,
  tree: 'oak', treeDensity: 0.7, grassDensity: 0.28, flowerDensity: 0.035, snowy: false, fogDensity: 0.85,
}));

add(d({
  id: Biome.Meadow, name: 'Луг',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.52, 0.76, 0.36], foliageColor: [0.40, 0.68, 0.26], waterColor: WATER_TEMPERATE,
  tree: 'oak', treeDensity: 0.3, grassDensity: 0.42, flowerDensity: 0.09, snowy: false, fogDensity: 0.8,
}));

add(d({
  id: Biome.Forest, name: 'Лес',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.44, 0.70, 0.31], foliageColor: [0.32, 0.62, 0.21], waterColor: WATER_TEMPERATE,
  tree: 'oak', treeDensity: 9, grassDensity: 0.22, flowerDensity: 0.02, snowy: false, fogDensity: 1.05,
}));

add(d({
  id: Biome.BirchForest, name: 'Берёзовый лес',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.50, 0.73, 0.34], foliageColor: [0.42, 0.68, 0.26], waterColor: WATER_TEMPERATE,
  tree: 'birch', treeDensity: 8, grassDensity: 0.24, flowerDensity: 0.03, snowy: false, fogDensity: 1.0,
}));

add(d({
  id: Biome.DarkForest, name: 'Тёмный лес',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.33, 0.58, 0.24], foliageColor: [0.22, 0.48, 0.16], waterColor: WATER_TEMPERATE,
  tree: 'darkOak', treeDensity: 12, grassDensity: 0.16, flowerDensity: 0.01, snowy: false, fogDensity: 1.3,
}));

add(d({
  id: Biome.Taiga, name: 'Тайга',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.40, 0.63, 0.38], foliageColor: [0.28, 0.52, 0.30], waterColor: WATER_COLD,
  tree: 'spruce', treeDensity: 10, grassDensity: 0.18, flowerDensity: 0.01, snowy: false, fogDensity: 1.15,
}));

add(d({
  id: Biome.SnowyTaiga, name: 'Снежная тайга',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.38, 0.58, 0.42], foliageColor: [0.26, 0.47, 0.32], waterColor: WATER_COLD,
  tree: 'tallSpruce', treeDensity: 7, grassDensity: 0.05, flowerDensity: 0, snowy: true, fogDensity: 1.2,
}));

// Snowy biomes deliberately do NOT use snow as their surface material. The
// decoration pass lays exactly one snow layer on top of whatever the surface
// is, and if the surface were already snow that pass would skip the column —
// leaving it a block lower than its neighbours. The result was a field of
// one-block pits whose shaded walls read as dark triangles across the ground.
add(d({
  id: Biome.SnowyPlains, name: 'Снежная равнина',
  surface: Block.Dirt, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.42, 0.60, 0.44], foliageColor: [0.30, 0.50, 0.34], waterColor: WATER_COLD,
  tree: 'none', treeDensity: 0.2, grassDensity: 0, flowerDensity: 0, snowy: true, fogDensity: 1.25,
}));

add(d({
  id: Biome.Desert, name: 'Пустыня',
  surface: Block.Sand, subsurface: Block.Sandstone, underwater: Block.Sand,
  grassColor: [0.74, 0.71, 0.33], foliageColor: [0.67, 0.65, 0.28], waterColor: WATER_WARM,
  tree: 'cactus', treeDensity: 1.2, grassDensity: 0.01, flowerDensity: 0, snowy: false, fogDensity: 0.6,
}));

add(d({
  id: Biome.Savanna, name: 'Саванна',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Dirt,
  grassColor: [0.74, 0.72, 0.34], foliageColor: [0.66, 0.66, 0.29], waterColor: WATER_WARM,
  tree: 'acacia', treeDensity: 1.5, grassDensity: 0.3, flowerDensity: 0.005, snowy: false, fogDensity: 0.7,
}));

add(d({
  id: Biome.Badlands, name: 'Бесплодные земли',
  surface: Block.RedSand, subsurface: Block.Sandstone, underwater: Block.RedSand,
  grassColor: [0.62, 0.55, 0.28], foliageColor: [0.60, 0.53, 0.26], waterColor: WATER_WARM,
  tree: 'none', treeDensity: 0.1, grassDensity: 0.01, flowerDensity: 0, snowy: false, fogDensity: 0.75,
}));

add(d({
  id: Biome.Swamp, name: 'Болото',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Clay,
  grassColor: [0.42, 0.51, 0.27], foliageColor: [0.36, 0.47, 0.22], waterColor: WATER_SWAMP,
  tree: 'swampOak', treeDensity: 4, grassDensity: 0.3, flowerDensity: 0.01, snowy: false, fogDensity: 1.9,
}));

add(d({
  id: Biome.StonyShore, name: 'Каменистый берег',
  surface: Block.Stone, subsurface: Block.Stone, underwater: Block.Gravel,
  grassColor: [0.46, 0.66, 0.34], foliageColor: [0.36, 0.60, 0.25], waterColor: WATER_COLD,
  tree: 'none', treeDensity: 0, grassDensity: 0.02, flowerDensity: 0, snowy: false, fogDensity: 1.0,
}));

add(d({
  id: Biome.Highlands, name: 'Предгорья',
  surface: Block.GrassBlock, subsurface: Block.Dirt, underwater: Block.Gravel,
  grassColor: [0.46, 0.68, 0.35], foliageColor: [0.34, 0.58, 0.26], waterColor: WATER_COLD,
  tree: 'spruce', treeDensity: 3, grassDensity: 0.2, flowerDensity: 0.03, snowy: false, fogDensity: 0.9,
}));

add(d({
  id: Biome.Mountains, name: 'Горы',
  surface: Block.Stone, subsurface: Block.Stone, underwater: Block.Gravel,
  grassColor: [0.44, 0.64, 0.36], foliageColor: [0.32, 0.55, 0.27], waterColor: WATER_COLD,
  tree: 'spruce', treeDensity: 0.6, grassDensity: 0.06, flowerDensity: 0.01, snowy: false, fogDensity: 0.7,
}));

add(d({
  id: Biome.SnowyPeaks, name: 'Снежные вершины',
  surface: Block.Stone, subsurface: Block.Stone, underwater: Block.Stone,
  grassColor: [0.44, 0.60, 0.44], foliageColor: [0.30, 0.50, 0.34], waterColor: WATER_COLD,
  tree: 'none', treeDensity: 0, grassDensity: 0, flowerDensity: 0, snowy: true, fogDensity: 0.8,
}));

for (let i = 0; i < Biome.Count; i++) {
  if (!DEFS[i]) throw new Error(`Биом ${i} не зарегистрирован`);
}

export const BIOMES: ReadonlyArray<BiomeDef> = DEFS;

/** Flat colour tables for the mesher's hot loop. */
export const BIOME_GRASS_RGB = new Float32Array(Biome.Count * 3);
export const BIOME_FOLIAGE_RGB = new Float32Array(Biome.Count * 3);
export const BIOME_WATER_RGB = new Float32Array(Biome.Count * 3);
export const BIOME_FOG_DENSITY = new Float32Array(Biome.Count);

for (const b of DEFS) {
  BIOME_GRASS_RGB.set(b.grassColor, b.id * 3);
  BIOME_FOLIAGE_RGB.set(b.foliageColor, b.id * 3);
  BIOME_WATER_RGB.set(b.waterColor, b.id * 3);
  BIOME_FOG_DENSITY[b.id] = b.fogDensity;
}

/**
 * Climate inputs, all in [-1, 1] except `height` which is in blocks.
 *
 * `continent` drives the land/ocean split, `erosion` decides between flat and
 * rugged relief at the same elevation, and temperature/humidity pick the
 * vegetation. Splitting relief from climate this way is what stops deserts
 * from appearing only in lowlands.
 */
export interface Climate {
  temperature: number;
  humidity: number;
  continent: number;
  erosion: number;
  weirdness: number;
}

export function classifyBiome(c: Climate, height: number, seaLevel: number): Biome {
  // --- water ---
  if (height < seaLevel - 12) return c.continent < -0.35 ? Biome.DeepOcean : Biome.Ocean;
  if (height < seaLevel - 1) {
    return c.continent < -0.2 ? Biome.Ocean : Biome.River;
  }

  // --- shore ---
  if (height <= seaLevel + 2) {
    if (c.temperature < -0.45) return Biome.StonyShore;
    if (c.erosion > 0.45) return Biome.StonyShore;
    return Biome.Beach;
  }

  // --- high elevation overrides climate ---
  const relative = height - seaLevel;
  if (relative > 96) return c.temperature < 0.35 ? Biome.SnowyPeaks : Biome.Mountains;
  if (relative > 62) {
    if (c.temperature < -0.15) return Biome.SnowyPeaks;
    return Biome.Mountains;
  }
  if (relative > 38) {
    if (c.temperature < -0.35) return Biome.SnowyTaiga;
    return Biome.Highlands;
  }

  // --- lowland climate grid ---
  const t = c.temperature;
  const h = c.humidity;

  if (t < -0.45) return h > 0.05 ? Biome.SnowyTaiga : Biome.SnowyPlains;
  if (t < -0.1) return h > 0.15 ? Biome.Taiga : Biome.SnowyPlains;

  if (t > 0.5) {
    if (h < -0.3) return c.weirdness > 0.4 ? Biome.Badlands : Biome.Desert;
    if (h < 0.1) return Biome.Savanna;
    return Biome.Forest;
  }

  if (t > 0.15) {
    if (h < -0.35) return Biome.Desert;
    if (h < -0.05) return Biome.Savanna;
    if (h > 0.55) return Biome.Swamp;
    return h > 0.3 ? Biome.DarkForest : Biome.Plains;
  }

  // temperate
  if (h < -0.25) return Biome.Plains;
  if (h > 0.55) return Biome.Swamp;
  if (h > 0.3) return c.weirdness > 0 ? Biome.BirchForest : Biome.Forest;
  if (h > 0.05) return Biome.Forest;
  return c.weirdness > 0.25 ? Biome.Meadow : Biome.Plains;
}

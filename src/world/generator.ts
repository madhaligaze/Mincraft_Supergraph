/**
 * Terrain generation.
 *
 * The shape of the world comes from four low-frequency fields — continent,
 * erosion, ridge and weirdness — evaluated on a *global* lattice with 4-block
 * spacing and bilinearly interpolated. Sampling a global lattice rather than a
 * per-chunk one is what guarantees that a tree placed from a neighbouring
 * chunk lands on exactly the ground that chunk generates: every chunk that
 * touches a lattice point computes the identical value for it.
 *
 * High-frequency surface detail is evaluated per column at full resolution,
 * because that is the part the eye reads as terrain texture.
 */

import { Noise, Cellular } from './noise.ts';
import { Block } from './blocks.ts';
import {
  Biome, BIOMES, classifyBiome, type Climate,
  BIOME_GRASS_RGB, BIOME_FOLIAGE_RGB,
} from './biomes.ts';
import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, BEDROCK_HEIGHT, columnIndex,
} from './constants.ts';
import { clamp, saturate, hash2i, hash3i, makeRng } from '../core/math.ts';

/** World-space spacing of the terrain lattice, in blocks. */
const LATTICE = 4;
/** Lattice points of padding on each side, so colour blending has neighbours. */
const LATTICE_PAD = 3;
const LATTICE_SPAN = CHUNK_SIZE / LATTICE + 1 + LATTICE_PAD * 2; // 15

/** Fields stored per lattice point. */
const L_CONT = 0;
const L_ERO = 1;
const L_RIDGE = 2;
const L_WEIRD = 3;
const L_TEMP = 4;
const L_HUMID = 5;
const L_RIVER = 6;
const L_ELEV = 7;
const L_STRIDE = 8;

/** Piecewise-linear spline through (x, y) control points, x ascending. */
function spline(x: number, points: readonly number[]): number {
  const n = points.length / 2;
  if (x <= points[0]) return points[1];
  for (let i = 1; i < n; i++) {
    const px = points[i * 2];
    if (x <= px) {
      const ax = points[(i - 1) * 2];
      const ay = points[(i - 1) * 2 + 1];
      const by = points[i * 2 + 1];
      const t = (x - ax) / (px - ax || 1);
      return ay + (by - ay) * t;
    }
  }
  return points[(n - 1) * 2 + 1];
}

/**
 * Continental elevation offset from sea level, in blocks.
 * The flat step around 0.0..0.25 is deliberate: it produces broad coastal
 * plains instead of a world where every landmass is a dome.
 */
const CONTINENT_SPLINE = [
  -1.0, -46,
  -0.62, -32,
  -0.38, -16,
  -0.22, -5,
  -0.08, 3,
  0.10, 7,
  0.28, 16,
  0.48, 30,
  0.72, 46,
  1.0, 62,
];

/**
 * Elevation above this is compressed toward an asymptote, so the tallest peaks
 * approach 62 + 76 + 44 = 182 without ever clipping flat against the world
 * ceiling. The curve is C1-continuous at the knee (slope 1), which keeps the
 * transition from foothill to summit smooth.
 */
const SOFT_KNEE = 76;
const SOFT_RANGE = 44;

function softCeiling(elev: number): number {
  if (elev <= SOFT_KNEE) return elev;
  const d = elev - SOFT_KNEE;
  return SOFT_KNEE + SOFT_RANGE * (1 - 1 / (1 + d / SOFT_RANGE));
}

/** How much relief the ridge term is allowed to add at a given erosion value. */
const EROSION_SPLINE = [
  -1.0, 1.55,
  -0.55, 1.15,
  -0.15, 0.78,
  0.20, 0.42,
  0.55, 0.20,
  1.0, 0.10,
];

export interface ColumnOutput {
  blocks: Uint8Array;
  biome: Uint8Array;
  /** Blended sRGB grass tint, 3 bytes per column. */
  grassTint: Uint8Array;
  /** Blended sRGB foliage tint, 3 bytes per column. */
  foliageTint: Uint8Array;
  /** Highest non-air block per column, -1 when empty. */
  heightmap: Int16Array;
  /** Highest opaque block, used to seed the skylight flood fill. */
  solidHeightmap: Int16Array;
}

export function createColumnOutput(): ColumnOutput {
  const area = CHUNK_SIZE * CHUNK_SIZE;
  return {
    blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT),
    biome: new Uint8Array(area),
    grassTint: new Uint8Array(area * 3),
    foliageTint: new Uint8Array(area * 3),
    heightmap: new Int16Array(area),
    solidHeightmap: new Int16Array(area),
  };
}

export class TerrainGenerator {
  private readonly continentNoise: Noise;
  private readonly erosionNoise: Noise;
  private readonly ridgeNoise: Noise;
  private readonly weirdNoise: Noise;
  private readonly tempNoise: Noise;
  private readonly humidNoise: Noise;
  private readonly riverNoise: Noise;
  private readonly detailNoise: Noise;
  private readonly caveNoiseA: Noise;
  private readonly caveNoiseB: Noise;
  private readonly caveNoiseC: Noise;
  private readonly chamberNoise: Cellular;
  private readonly surfaceNoise: Noise;

  /** Scratch lattice for the chunk currently being generated. */
  private readonly lattice = new Float32Array(LATTICE_SPAN * LATTICE_SPAN * L_STRIDE);
  /** Blended biome colours per lattice point, linear 0..1. */
  private readonly latticeGrass = new Float32Array(LATTICE_SPAN * LATTICE_SPAN * 3);
  private readonly latticeFoliage = new Float32Array(LATTICE_SPAN * LATTICE_SPAN * 3);
  private readonly latticeBiome = new Uint8Array(LATTICE_SPAN * LATTICE_SPAN);

  private readonly climateScratch: Climate = {
    temperature: 0, humidity: 0, continent: 0, erosion: 0, weirdness: 0,
  };

  /**
   * Cave density lattice: 4-block spacing horizontally and vertically. Caves
   * are smooth enough that interpolating at this rate is visually identical to
   * per-voxel evaluation and is 64x cheaper.
   */
  private readonly caveSpanXZ = CHUNK_SIZE / 4 + 1; // 9
  private readonly caveSpanY = WORLD_HEIGHT / 4 + 1; // 65
  private readonly caveField: Float32Array;

  constructor(readonly seed: number) {
    this.continentNoise = new Noise(seed ^ 0x1a2b3c4d);
    this.erosionNoise = new Noise(seed ^ 0x5e6f7a8b);
    this.ridgeNoise = new Noise(seed ^ 0x9c0d1e2f);
    this.weirdNoise = new Noise(seed ^ 0x3a4b5c6d);
    this.tempNoise = new Noise(seed ^ 0x7e8f9a0b);
    this.humidNoise = new Noise(seed ^ 0xb1c2d3e4);
    this.riverNoise = new Noise(seed ^ 0xf5a6b7c8);
    this.detailNoise = new Noise(seed ^ 0x2d3e4f50);
    this.caveNoiseA = new Noise(seed ^ 0x61728394);
    this.caveNoiseB = new Noise(seed ^ 0xa5b6c7d8);
    this.caveNoiseC = new Noise(seed ^ 0xe9fa0b1c);
    this.chamberNoise = new Cellular(seed ^ 0x2233445);
    this.surfaceNoise = new Noise(seed ^ 0x66778899);
    this.caveField = new Float32Array(this.caveSpanXZ * this.caveSpanXZ * this.caveSpanY);
  }

  // -------------------------------------------------------------------------
  // Lattice sampling
  // -------------------------------------------------------------------------

  /**
   * Evaluates the low-frequency fields at a global lattice point.
   * `lx`/`lz` are lattice indices; world position is `lx * LATTICE`.
   */
  private sampleLattice(lx: number, lz: number, out: Float32Array, offset: number): void {
    const x = lx * LATTICE;
    const z = lz * LATTICE;

    const cont = this.continentNoise.fbm2(x * 0.00092, z * 0.00092, 5);
    const ero = this.erosionNoise.fbm2(x * 0.0016, z * 0.0016, 4);
    const ridge = this.ridgeNoise.ridged2(x * 0.0023, z * 0.0023, 5);
    const weird = this.weirdNoise.fbm2(x * 0.0011, z * 0.0011, 3);
    const temp = this.tempNoise.fbm2(x * 0.00055, z * 0.00055, 4);
    const humid = this.humidNoise.fbm2(x * 0.00072, z * 0.00072, 4);
    const river = this.riverNoise.fbm2(x * 0.00115, z * 0.00115, 3);

    out[offset + L_CONT] = cont;
    out[offset + L_ERO] = ero;
    out[offset + L_RIDGE] = ridge;
    out[offset + L_WEIRD] = weird;
    out[offset + L_TEMP] = temp;
    out[offset + L_HUMID] = humid;
    out[offset + L_RIVER] = river;
    out[offset + L_ELEV] = this.elevation(cont, ero, ridge, weird, river);
  }

  /** Combines the low-frequency fields into an elevation offset from sea level. */
  private elevation(
    cont: number, ero: number, ridge: number, weird: number, river: number,
  ): number {
    const base = spline(cont, CONTINENT_SPLINE);
    const erosionFactor = spline(ero, EROSION_SPLINE);

    // Ridges only build up once the continental base is above the shelf, so
    // mountains rise out of land rather than out of the sea.
    const landMask = saturate((base + 4) / 26);
    const ridgePow = ridge * ridge * (3 - 2 * ridge); // smoothstep-shaped
    const ridgeTerm = ridgePow * 86 * erosionFactor * landMask;

    // Weirdness tilts a region toward plateaus or toward broken relief.
    const weirdTerm = weird * 9 * erosionFactor * landMask;

    let elev = softCeiling(base + ridgeTerm + weirdTerm);

    // Rivers: carve a channel toward just below sea level, but only where the
    // land is low enough that a river makes sense.
    const riverMask = 1 - saturate((Math.abs(river) - 0.010) / 0.042);
    if (riverMask > 0) {
      const altitudeFade = 1 - saturate((elev - 6) / 34);
      const strength = riverMask * riverMask * altitudeFade;
      elev = elev + (-4 - elev) * strength * 0.92;
    }

    return elev;
  }

  /** Builds the lattice window covering a chunk plus its colour-blend padding. */
  private buildLattice(chunkX: number, chunkZ: number): void {
    const baseLX = Math.floor((chunkX * CHUNK_SIZE) / LATTICE) - LATTICE_PAD;
    const baseLZ = Math.floor((chunkZ * CHUNK_SIZE) / LATTICE) - LATTICE_PAD;

    const climate = this.climateScratch;

    for (let j = 0; j < LATTICE_SPAN; j++) {
      for (let i = 0; i < LATTICE_SPAN; i++) {
        const index = j * LATTICE_SPAN + i;
        const offset = index * L_STRIDE;
        this.sampleLattice(baseLX + i, baseLZ + j, this.lattice, offset);

        climate.continent = this.lattice[offset + L_CONT];
        climate.erosion = this.lattice[offset + L_ERO];
        climate.weirdness = this.lattice[offset + L_WEIRD];
        climate.temperature = this.lattice[offset + L_TEMP];
        climate.humidity = this.lattice[offset + L_HUMID];

        const height = SEA_LEVEL + this.lattice[offset + L_ELEV];
        const biome = classifyBiome(climate, height, SEA_LEVEL);
        this.latticeBiome[index] = biome;
      }
    }

    // Blend colours over a 3x3 lattice window (a 24-block kernel). Doing this
    // on the lattice rather than per column costs 225 taps instead of 9216 and
    // is what removes the hard colour edge at biome boundaries.
    for (let j = 0; j < LATTICE_SPAN; j++) {
      for (let i = 0; i < LATTICE_SPAN; i++) {
        let gr = 0, gg = 0, gb = 0;
        let fr = 0, fg = 0, fb = 0;
        let total = 0;

        for (let dj = -1; dj <= 1; dj++) {
          const jj = clamp(j + dj, 0, LATTICE_SPAN - 1);
          for (let di = -1; di <= 1; di++) {
            const ii = clamp(i + di, 0, LATTICE_SPAN - 1);
            // Centre-weighted so a biome keeps its own identity.
            const w = di === 0 && dj === 0 ? 2.5 : 1;
            const b = this.latticeBiome[jj * LATTICE_SPAN + ii] * 3;
            gr += BIOME_GRASS_RGB[b] * w;
            gg += BIOME_GRASS_RGB[b + 1] * w;
            gb += BIOME_GRASS_RGB[b + 2] * w;
            fr += BIOME_FOLIAGE_RGB[b] * w;
            fg += BIOME_FOLIAGE_RGB[b + 1] * w;
            fb += BIOME_FOLIAGE_RGB[b + 2] * w;
            total += w;
          }
        }

        const index = (j * LATTICE_SPAN + i) * 3;
        const inv = 1 / total;
        this.latticeGrass[index] = gr * inv;
        this.latticeGrass[index + 1] = gg * inv;
        this.latticeGrass[index + 2] = gb * inv;
        this.latticeFoliage[index] = fr * inv;
        this.latticeFoliage[index + 1] = fg * inv;
        this.latticeFoliage[index + 2] = fb * inv;
      }
    }
  }

  /**
   * Terrain height at any world position, using the same global lattice as
   * chunk generation. Used for tree placement and for spawn finding.
   */
  surfaceHeightAt(x: number, z: number): number {
    const fx = x / LATTICE;
    const fz = z / LATTICE;
    const lx = Math.floor(fx);
    const lz = Math.floor(fz);
    const tx = fx - lx;
    const tz = fz - lz;

    const scratch = new Float32Array(L_STRIDE * 4);
    this.sampleLattice(lx, lz, scratch, 0);
    this.sampleLattice(lx + 1, lz, scratch, L_STRIDE);
    this.sampleLattice(lx, lz + 1, scratch, L_STRIDE * 2);
    this.sampleLattice(lx + 1, lz + 1, scratch, L_STRIDE * 3);

    const e00 = scratch[L_ELEV];
    const e10 = scratch[L_STRIDE + L_ELEV];
    const e01 = scratch[L_STRIDE * 2 + L_ELEV];
    const e11 = scratch[L_STRIDE * 3 + L_ELEV];
    const elev = (e00 * (1 - tx) + e10 * tx) * (1 - tz) + (e01 * (1 - tx) + e11 * tx) * tz;

    const ero = (scratch[L_ERO] * (1 - tx) + scratch[L_STRIDE + L_ERO] * tx) * (1 - tz) +
      (scratch[L_STRIDE * 2 + L_ERO] * (1 - tx) + scratch[L_STRIDE * 3 + L_ERO] * tx) * tz;

    return this.applyDetail(x, z, SEA_LEVEL + elev, ero);
  }

  /** Adds the full-resolution surface detail on top of the lattice elevation. */
  private applyDetail(x: number, z: number, height: number, erosion: number): number {
    const roughness = spline(erosion, EROSION_SPLINE);
    const detail = this.detailNoise.fbm2(x * 0.0125, z * 0.0125, 4) * 5.5 * roughness;
    const micro = this.detailNoise.noise2(x * 0.061, z * 0.061) * 1.1 * roughness;
    return height + detail + micro;
  }

  /** Climate at a world position, for the HUD readout and for spawn selection. */
  climateAt(x: number, z: number, out: Climate): Climate {
    out.continent = this.continentNoise.fbm2(x * 0.00092, z * 0.00092, 5);
    out.erosion = this.erosionNoise.fbm2(x * 0.0016, z * 0.0016, 4);
    out.weirdness = this.weirdNoise.fbm2(x * 0.0011, z * 0.0011, 3);
    out.temperature = this.tempNoise.fbm2(x * 0.00055, z * 0.00055, 4);
    out.humidity = this.humidNoise.fbm2(x * 0.00072, z * 0.00072, 4);
    return out;
  }

  biomeAt(x: number, z: number): Biome {
    const climate = this.climateAt(x, z, {
      temperature: 0, humidity: 0, continent: 0, erosion: 0, weirdness: 0,
    });
    return classifyBiome(climate, this.surfaceHeightAt(x, z), SEA_LEVEL);
  }

  // -------------------------------------------------------------------------
  // Caves
  // -------------------------------------------------------------------------

  /**
   * Fills the cave density lattice for a chunk.
   *
   * Two independent noise fields intersected near zero produce worm-like
   * tunnels rather than the swiss-cheese blobs a single threshold gives; a
   * third large-scale field opens occasional chambers.
   */
  private buildCaveField(chunkX: number, chunkZ: number): void {
    const field = this.caveField;
    const spanXZ = this.caveSpanXZ;
    const spanY = this.caveSpanY;
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;

    for (let iy = 0; iy < spanY; iy++) {
      const y = iy * 4;
      // Caves fade out near bedrock and near the surface; the surface taper is
      // finished per-voxel against the actual column height.
      const depthFade = saturate((y - 2) / 8) * (1 - saturate((y - 72) / 34));
      if (depthFade <= 0) {
        for (let iz = 0; iz < spanXZ; iz++) {
          for (let ix = 0; ix < spanXZ; ix++) {
            field[(iy * spanXZ + iz) * spanXZ + ix] = 0;
          }
        }
        continue;
      }

      for (let iz = 0; iz < spanXZ; iz++) {
        const z = originZ + iz * 4;
        for (let ix = 0; ix < spanXZ; ix++) {
          const x = originX + ix * 4;

          // Vertical scale is squashed so tunnels run horizontally.
          const a = this.caveNoiseA.fbm3(x * 0.0128, y * 0.0225, z * 0.0128, 2);
          const b = this.caveNoiseB.fbm3(x * 0.0128, y * 0.0225, z * 0.0128, 2);
          const tunnel = Math.max(0, 1 - (a * a + b * b) * 44);

          const chamberD = this.chamberNoise.f1(x * 0.0136, y * 0.0245, z * 0.0136);
          const chamber = Math.max(0, 1 - chamberD * 2.1) *
            saturate((this.caveNoiseC.noise3(x * 0.0031, y * 0.006, z * 0.0031) + 0.25) * 2);

          field[(iy * spanXZ + iz) * spanXZ + ix] =
            Math.min(1, tunnel + chamber * 0.85) * depthFade;
        }
      }
    }
  }

  /** Trilinear sample of the cave lattice at chunk-local coordinates. */
  private caveAt(lx: number, y: number, lz: number): number {
    const spanXZ = this.caveSpanXZ;
    const field = this.caveField;

    const fx = lx * 0.25, fy = y * 0.25, fz = lz * 0.25;
    const ix = Math.min(spanXZ - 2, fx | 0);
    const iy = Math.min(this.caveSpanY - 2, fy | 0);
    const iz = Math.min(spanXZ - 2, fz | 0);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;

    const idx = (yy: number, zz: number, xx: number): number =>
      (yy * spanXZ + zz) * spanXZ + xx;

    const c000 = field[idx(iy, iz, ix)];
    const c100 = field[idx(iy, iz, ix + 1)];
    const c010 = field[idx(iy, iz + 1, ix)];
    const c110 = field[idx(iy, iz + 1, ix + 1)];
    const c001 = field[idx(iy + 1, iz, ix)];
    const c101 = field[idx(iy + 1, iz, ix + 1)];
    const c011 = field[idx(iy + 1, iz + 1, ix)];
    const c111 = field[idx(iy + 1, iz + 1, ix + 1)];

    const x00 = c000 + (c100 - c000) * tx;
    const x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx;
    const x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * tz;
    const y1 = x01 + (x11 - x01) * tz;
    return y0 + (y1 - y0) * ty;
  }

  // -------------------------------------------------------------------------
  // Column generation
  // -------------------------------------------------------------------------

  generate(chunkX: number, chunkZ: number, out: ColumnOutput): void {
    this.buildLattice(chunkX, chunkZ);
    this.buildCaveField(chunkX, chunkZ);

    const { blocks, biome, grassTint, foliageTint, heightmap, solidHeightmap } = out;
    blocks.fill(0);

    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;

    // Lattice index of the chunk origin inside the padded window.
    const baseOffsetX = originX / LATTICE - (Math.floor(originX / LATTICE) - LATTICE_PAD);
    const baseOffsetZ = originZ / LATTICE - (Math.floor(originZ / LATTICE) - LATTICE_PAD);

    const climate = this.climateScratch;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const worldZ = originZ + lz;
      const fz = baseOffsetZ + lz / LATTICE;
      const jz = fz | 0;
      const tz = fz - jz;

      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const worldX = originX + lx;
        const fx = baseOffsetX + lx / LATTICE;
        const jx = fx | 0;
        const tx = fx - jx;

        const i00 = (jz * LATTICE_SPAN + jx) * L_STRIDE;
        const i10 = (jz * LATTICE_SPAN + jx + 1) * L_STRIDE;
        const i01 = ((jz + 1) * LATTICE_SPAN + jx) * L_STRIDE;
        const i11 = ((jz + 1) * LATTICE_SPAN + jx + 1) * L_STRIDE;

        const w00 = (1 - tx) * (1 - tz);
        const w10 = tx * (1 - tz);
        const w01 = (1 - tx) * tz;
        const w11 = tx * tz;

        const bilerp = (field: number): number =>
          this.lattice[i00 + field] * w00 + this.lattice[i10 + field] * w10 +
          this.lattice[i01 + field] * w01 + this.lattice[i11 + field] * w11;

        const elev = bilerp(L_ELEV);
        const erosion = bilerp(L_ERO);

        climate.continent = bilerp(L_CONT);
        climate.erosion = erosion;
        climate.weirdness = bilerp(L_WEIRD);
        climate.temperature = bilerp(L_TEMP);
        climate.humidity = bilerp(L_HUMID);

        const heightF = this.applyDetail(worldX, worldZ, SEA_LEVEL + elev, erosion);
        const height = Math.max(1, Math.min(WORLD_HEIGHT - 2, Math.round(heightF)));

        const columnBiome = classifyBiome(climate, height, SEA_LEVEL);
        const area = lz * CHUNK_SIZE + lx;
        biome[area] = columnBiome;

        // Bilinear blend of the already-smoothed lattice colours.
        const g00 = (jz * LATTICE_SPAN + jx) * 3;
        const g10 = (jz * LATTICE_SPAN + jx + 1) * 3;
        const g01 = ((jz + 1) * LATTICE_SPAN + jx) * 3;
        const g11 = ((jz + 1) * LATTICE_SPAN + jx + 1) * 3;
        for (let c = 0; c < 3; c++) {
          const grass = this.latticeGrass[g00 + c] * w00 + this.latticeGrass[g10 + c] * w10 +
            this.latticeGrass[g01 + c] * w01 + this.latticeGrass[g11 + c] * w11;
          const foliage = this.latticeFoliage[g00 + c] * w00 + this.latticeFoliage[g10 + c] * w10 +
            this.latticeFoliage[g01 + c] * w01 + this.latticeFoliage[g11 + c] * w11;
          grassTint[area * 3 + c] = Math.round(saturate(grass) * 255);
          foliageTint[area * 3 + c] = Math.round(saturate(foliage) * 255);
        }

        this.fillColumn(blocks, lx, lz, worldX, worldZ, height, columnBiome);

        // Heightmaps are finished after decoration; seed them from terrain.
        heightmap[area] = height;
        solidHeightmap[area] = height;
      }
    }

    this.placeOres(blocks, chunkX, chunkZ);
    this.decorate(blocks, biome, chunkX, chunkZ);
    this.finishHeightmaps(blocks, heightmap, solidHeightmap);
  }

  /** Fills one vertical column: stone, surface material, water and caves. */
  private fillColumn(
    blocks: Uint8Array,
    lx: number, lz: number,
    worldX: number, worldZ: number,
    height: number,
    columnBiome: Biome,
  ): void {
    const def = BIOMES[columnBiome];
    const underwater = height < SEA_LEVEL;

    // Surface layer thickness varies so the dirt/stone boundary is not a
    // perfectly parallel offset of the terrain.
    const soilNoise = this.surfaceNoise.noise2(worldX * 0.09, worldZ * 0.09);
    const soilDepth = 3 + Math.round(soilNoise * 1.6);

    const surfaceBlock = underwater ? def.underwater : def.surface;
    const subsurfaceBlock = def.subsurface;

    // Steep slopes expose stone regardless of biome — this is what stops
    // mountains from looking like grass-wrapped cones.
    const slope = Math.abs(
      this.surfaceNoise.noise2(worldX * 0.021 + 100, worldZ * 0.021) * 2,
    );

    for (let y = 0; y <= height; y++) {
      let block: number;

      if (y < BEDROCK_HEIGHT) {
        // Ragged bedrock floor rather than a flat slab.
        block = y === 0 || hash3i(worldX, y, worldZ) % 5 < (BEDROCK_HEIGHT - y)
          ? Block.Bedrock
          : Block.Stone;
      } else if (y === height) {
        block = surfaceBlock;
      } else if (y > height - soilDepth) {
        block = subsurfaceBlock;
      } else {
        block = Block.Stone;
        // Stone variants in broad patches.
        const variant = this.surfaceNoise.noise3(
          worldX * 0.017, y * 0.017, worldZ * 0.017,
        );
        if (variant > 0.42) block = Block.Granite;
        else if (variant < -0.42) block = Block.Andesite;
      }

      // Slope override: replace soil with stone on steep faces above the shore.
      if (
        block !== Block.Bedrock && block !== Block.Stone &&
        block !== Block.Granite && block !== Block.Andesite &&
        height > SEA_LEVEL + 3 && slope > 1.35 && y > height - soilDepth - 1
      ) {
        block = Block.Stone;
      }

      // Carve caves. The surface taper keeps tunnels from cutting open holes
      // in the terrain skin except where they genuinely reach it.
      if (y >= BEDROCK_HEIGHT && block !== Block.Bedrock) {
        const surfaceTaper = saturate((height - y - 3) / 6);
        if (surfaceTaper > 0 && this.caveAt(lx, y, lz) * surfaceTaper > 0.52) {
          // Below sea level caves flood; above, they stay open.
          block = y < 11 ? Block.Lava : Block.Air;
        }
      }

      blocks[columnIndex(lx, y, lz)] = block;
    }

    // Ocean, lake and river water.
    if (height < SEA_LEVEL) {
      for (let y = height + 1; y <= SEA_LEVEL; y++) {
        blocks[columnIndex(lx, y, lz)] = Block.Water;
      }
    }
  }

  /** Scatters ore veins using a per-chunk deterministic RNG. */
  private placeOres(blocks: Uint8Array, chunkX: number, chunkZ: number): void {
    const rng = makeRng(hash2i(chunkX, chunkZ) ^ this.seed);

    // [block, veins per chunk, max y, vein size]
    const veins: ReadonlyArray<readonly [Block, number, number, number]> = [
      [Block.CoalOre, 14, 100, 12],
      [Block.IronOre, 9, 76, 8],
      [Block.GoldOre, 3, 34, 6],
      [Block.DiamondOre, 1.2, 18, 5],
    ];

    for (const [ore, count, maxY, size] of veins) {
      const n = Math.floor(count) + (rng() < count % 1 ? 1 : 0);
      for (let v = 0; v < n; v++) {
        let x = Math.floor(rng() * CHUNK_SIZE);
        let y = BEDROCK_HEIGHT + Math.floor(rng() * (maxY - BEDROCK_HEIGHT));
        let z = Math.floor(rng() * CHUNK_SIZE);
        const blobs = 2 + Math.floor(rng() * size);

        // Random walk so veins are elongated rather than spherical.
        for (let b = 0; b < blobs; b++) {
          if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y > 0 && y < WORLD_HEIGHT) {
            const index = columnIndex(x, y, z);
            const existing = blocks[index];
            if (
              existing === Block.Stone || existing === Block.Granite ||
              existing === Block.Andesite
            ) {
              blocks[index] = ore;
            }
          }
          x += Math.round(rng() * 2 - 1);
          y += Math.round(rng() * 2 - 1);
          z += Math.round(rng() * 2 - 1);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Decoration
  // -------------------------------------------------------------------------

  /**
   * Places vegetation. Trees are generated for the 3x3 block of chunks around
   * this one and clipped to its bounds, so a canopy that straddles a border is
   * produced identically by both chunks without any cross-chunk writes.
   */
  private decorate(
    blocks: Uint8Array, biome: Uint8Array, chunkX: number, chunkZ: number,
  ): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.placeTreesFrom(blocks, chunkX + dx, chunkZ + dz, chunkX, chunkZ);
      }
    }
    this.placeGroundCover(blocks, biome, chunkX, chunkZ);
  }

  private placeTreesFrom(
    blocks: Uint8Array,
    sourceChunkX: number, sourceChunkZ: number,
    targetChunkX: number, targetChunkZ: number,
  ): void {
    const originX = sourceChunkX * CHUNK_SIZE;
    const originZ = sourceChunkZ * CHUNK_SIZE;
    const rng = makeRng(hash2i(sourceChunkX * 7919, sourceChunkZ * 104729) ^ this.seed);

    // Density comes from the biome at the chunk centre; a chunk that spans two
    // biomes gets the transition from per-tree biome checks below.
    const centreBiome = this.biomeAt(originX + 16, originZ + 16);
    const density = BIOMES[centreBiome].treeDensity;
    if (density <= 0) return;

    const attempts = Math.ceil(density * 2.5);

    for (let i = 0; i < attempts; i++) {
      if (rng() > density / attempts * 2.5) continue;

      const x = originX + Math.floor(rng() * CHUNK_SIZE);
      const z = originZ + Math.floor(rng() * CHUNK_SIZE);

      const localBiome = this.biomeAt(x, z);
      const def = BIOMES[localBiome];
      if (def.tree === 'none') continue;

      const height = Math.round(this.surfaceHeightAt(x, z));
      if (height <= SEA_LEVEL) continue;
      if (height > WORLD_HEIGHT - 40) continue;

      this.buildTree(
        blocks, def.tree, x, height + 1, z,
        targetChunkX, targetChunkZ, rng,
      );
    }
  }

  /** Emits one tree, clipping every block to the target chunk. */
  private buildTree(
    blocks: Uint8Array,
    kind: string,
    baseX: number, baseY: number, baseZ: number,
    targetChunkX: number, targetChunkZ: number,
    rng: () => number,
  ): void {
    const minX = targetChunkX * CHUNK_SIZE;
    const minZ = targetChunkZ * CHUNK_SIZE;

    const put = (x: number, y: number, z: number, block: Block, overwrite: boolean): void => {
      const lx = x - minX;
      const lz = z - minZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      if (y < 0 || y >= WORLD_HEIGHT) return;
      const index = columnIndex(lx, y, lz);
      if (!overwrite && blocks[index] !== Block.Air) return;
      blocks[index] = block;
    };

    const leafBall = (
      cx: number, cy: number, cz: number,
      rx: number, ry: number, leaf: Block, jitter: number,
    ): void => {
      for (let y = -ry; y <= ry; y++) {
        for (let z = -rx; z <= rx; z++) {
          for (let x = -rx; x <= rx; x++) {
            const dx = x / (rx + 0.35);
            const dy = y / (ry + 0.35);
            const dz = z / (rx + 0.35);
            const d = dx * dx + dy * dy + dz * dz;
            if (d > 1) continue;
            // Hash-based nibbling of the silhouette so canopies are not
            // perfect ellipsoids.
            if (d > 1 - jitter && (hash3i(cx + x, cy + y, cz + z) & 3) === 0) continue;
            put(cx + x, cy + y, cz + z, leaf, false);
          }
        }
      }
    };

    /**
     * A limb from the trunk out to a point, stepped one block at a time.
     *
     * This is what the trees were missing. Without branches a canopy is a lump
     * of leaves balanced on a bare pole with nothing joining the two, and from
     * underneath — which is where a player stands — that reads as a mushroom
     * rather than as a tree. A limb also gives the crown somewhere to hang off
     * that is not the trunk's own axis, which is most of what stops a stand of
     * trees from looking stamped from one mould.
     */
    const limb = (
      fromX: number, fromY: number, fromZ: number,
      toX: number, toY: number, toZ: number,
      wood: Block,
    ): void => {
      const dx = toX - fromX;
      const dy = toY - fromY;
      const dz = toZ - fromZ;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
      if (steps <= 0) {
        put(fromX, fromY, fromZ, wood, true);
        return;
      }

      // From `i = 0`, so the joint itself is wood.
      //
      // Starting at 1 left the block where the limb meets the trunk empty:
      // one step along a diagonal already moves in every axis at once, so the
      // first block placed was offset from the trunk in x, y and z and shared
      // only a corner with it. The crown then hung in the air above a trunk
      // that stopped short of it, which is exactly what a tree must never do.
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.round(fromX + dx * t);
        const y = Math.round(fromY + dy * t);
        const z = Math.round(fromZ + dz * t);
        put(x, y, z, wood, true);

        // A diagonal step moves horizontally and vertically in the same block,
        // which leaves the limb joined only along an edge — visible as a gap
        // from underneath. Filling the cell below the step closes it.
        if (i > 0 && dy !== 0) put(x, y - 1, z, wood, false);
      }
    };

    /** Picks `count` roughly even directions around the trunk, rotated by the rng. */
    const spokes = (count: number): Array<[number, number]> => {
      const base = rng() * Math.PI * 2;
      const out: Array<[number, number]> = [];
      for (let i = 0; i < count; i++) {
        const a = base + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.7;
        out.push([Math.cos(a), Math.sin(a)]);
      }
      return out;
    };

    switch (kind) {
      case 'oak':
      case 'swampOak': {
        const trunk = 5 + Math.floor(rng() * 3) + (kind === 'swampOak' ? 1 : 0);
        const top = baseY + trunk;
        for (let y = 0; y < trunk; y++) put(baseX, baseY + y, baseZ, Block.OakLog, true);

        // Two or three limbs out of the upper third, each carrying its own
        // clump. The crown is then the union of several overlapping balls
        // rather than one ellipsoid, which is what gives an oak its lumpy
        // silhouette and keeps two neighbouring oaks from being the same tree.
        for (const [dx, dz] of spokes(2 + Math.floor(rng() * 2))) {
          const reach = 2 + Math.floor(rng() * 2);
          const from = top - 2 - Math.floor(rng() * 2);
          const endX = baseX + Math.round(dx * reach);
          const endZ = baseZ + Math.round(dz * reach);
          const endY = from + 1 + Math.floor(rng() * 2);
          limb(baseX, from, baseZ, endX, endY, endZ, Block.OakLog);
          leafBall(endX, endY, endZ, 2, 2, Block.OakLeaves, 0.45);
        }

        leafBall(baseX, top, baseZ, 2, 2, Block.OakLeaves, 0.4);
        leafBall(baseX, top - 2, baseZ, 3, 2, Block.OakLeaves, 0.5);
        break;
      }
      case 'birch': {
        // Slim and tall, with the crown high up: a birch is mostly trunk, and
        // the narrow crown is what tells it apart from an oak at a distance.
        const trunk = 7 + Math.floor(rng() * 4);
        const top = baseY + trunk;
        for (let y = 0; y < trunk; y++) put(baseX, baseY + y, baseZ, Block.BirchLog, true);

        for (const [dx, dz] of spokes(2)) {
          const from = top - 2;
          const endX = baseX + Math.round(dx * 2);
          const endZ = baseZ + Math.round(dz * 2);
          limb(baseX, from, baseZ, endX, from + 2, endZ, Block.BirchLog);
          leafBall(endX, from + 2, endZ, 2, 2, Block.BirchLeaves, 0.45);
        }

        leafBall(baseX, top, baseZ, 2, 3, Block.BirchLeaves, 0.4);
        leafBall(baseX, top - 3, baseZ, 2, 2, Block.BirchLeaves, 0.5);
        break;
      }
      case 'darkOak': {
        const trunk = 6 + Math.floor(rng() * 3);
        const top = baseY + trunk;
        for (let y = 0; y < trunk; y++) {
          // 2x2 trunk.
          put(baseX, baseY + y, baseZ, Block.OakLog, true);
          put(baseX + 1, baseY + y, baseZ, Block.OakLog, true);
          put(baseX, baseY + y, baseZ + 1, Block.OakLog, true);
          put(baseX + 1, baseY + y, baseZ + 1, Block.OakLog, true);
        }

        // Four heavy limbs and a broad two-tier crown. Dark oak is the tree
        // whose canopy is supposed to close over the player's head.
        for (const [dx, dz] of spokes(4)) {
          const reach = 3 + Math.floor(rng() * 2);
          const from = top - 2;
          const endX = baseX + Math.round(dx * reach);
          const endZ = baseZ + Math.round(dz * reach);
          limb(baseX, from, baseZ, endX, from + 1, endZ, Block.OakLog);
          leafBall(endX, from + 1, endZ, 2, 2, Block.OakLeaves, 0.5);
        }

        leafBall(baseX, top, baseZ, 4, 2, Block.OakLeaves, 0.45);
        leafBall(baseX, top - 2, baseZ, 3, 1, Block.OakLeaves, 0.55);
        break;
      }
      case 'spruce':
      case 'tallSpruce': {
        const trunk = (kind === 'tallSpruce' ? 11 : 8) + Math.floor(rng() * 4);
        for (let y = 0; y < trunk; y++) put(baseX, baseY + y, baseZ, Block.SpruceLog, true);

        // A cone, not a stack of alternating discs.
        //
        // The old shape stepped the radius 3, 2, 3, 2 up the trunk, which is
        // neither a taper nor a set of tiers — it just looked like a mistake.
        // The radius now falls off with height and is modulated by a slow
        // ripple, so the tree keeps the tiered look a conifer has while still
        // narrowing to a point.
        const base = kind === 'tallSpruce' ? 3.4 : 2.9;
        const bottom = 2;
        for (let y = trunk; y >= bottom; y--) {
          const t = (y - bottom) / Math.max(1, trunk - bottom);
          // Tiers: full at the whorls, pulled in between them.
          const tier = 0.72 + 0.28 * Math.cos((y - bottom) * 1.05);
          const radius = base * (1 - t * 0.92) * tier;
          if (radius < 0.4) {
            put(baseX, baseY + y, baseZ, Block.SpruceLeaves, false);
            continue;
          }
          const r = Math.ceil(radius);
          for (let z = -r; z <= r; z++) {
            for (let x = -r; x <= r; x++) {
              const d = Math.sqrt(x * x + z * z);
              if (d > radius) continue;
              // Ragged edge, or the cone reads as turned on a lathe.
              if (d > radius - 0.9 && (hash3i(baseX + x, baseY + y, baseZ + z) & 3) === 0) {
                continue;
              }
              put(baseX + x, baseY + y, baseZ + z, Block.SpruceLeaves, false);
            }
          }
        }
        put(baseX, baseY + trunk + 1, baseZ, Block.SpruceLeaves, false);
        break;
      }
      case 'acacia': {
        // The umbrella, forked.
        //
        // What was here before was one leaning pole with a disc one block thick
        // on top: from below, a bare stem holding a plate, which is the shape
        // that got reported as a mushroom. A real acacia forks partway up and
        // each fork spreads its own flat crown, and the crown is thick enough
        // to be a canopy rather than a lid.
        const trunk = 4 + Math.floor(rng() * 2);
        for (let y = 0; y < trunk; y++) put(baseX, baseY + y, baseZ, Block.OakLog, true);

        const forkY = baseY + trunk;
        const forks = spokes(2);
        for (const [dx, dz] of forks) {
          const reach = 2 + Math.floor(rng() * 2);
          const rise = 2 + Math.floor(rng() * 2);
          const endX = baseX + Math.round(dx * reach);
          const endZ = baseZ + Math.round(dz * reach);
          const endY = forkY + rise;
          limb(baseX, forkY, baseZ, endX, endY, endZ, Block.OakLog);

          // Flat but not thin: three blocks at the middle, tapering out.
          const spread = 3;
          for (let z = -spread; z <= spread; z++) {
            for (let x = -spread; x <= spread; x++) {
              const d2 = x * x + z * z;
              if (d2 > spread * spread + 1) continue;
              const thickness = d2 <= 2 ? 2 : d2 <= 6 ? 1 : 0;
              for (let y = -thickness; y <= 1; y++) {
                if (d2 > 6 && y < 0) continue;
                put(endX + x, endY + y, endZ + z, Block.OakLeaves, false);
              }
            }
          }
        }
        break;
      }
      case 'cactus': {
        const trunk = 2 + Math.floor(rng() * 3);
        for (let y = 0; y < trunk; y++) put(baseX, baseY + y, baseZ, Block.Cactus, true);
        break;
      }
      default:
        break;
    }
  }

  /** Grass, ferns, flowers and snow layers on top of the finished terrain. */
  private placeGroundCover(
    blocks: Uint8Array, biome: Uint8Array, chunkX: number, chunkZ: number,
  ): void {
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const def = BIOMES[biome[lz * CHUNK_SIZE + lx]];

        // Find the topmost non-air block in this column.
        let top = -1;
        for (let y = WORLD_HEIGHT - 2; y >= 0; y--) {
          const b = blocks[columnIndex(lx, y, lz)];
          if (b !== Block.Air && b !== Block.Water) {
            top = y;
            break;
          }
        }
        if (top < 0 || top + 1 >= WORLD_HEIGHT) continue;

        const above = blocks[columnIndex(lx, top + 1, lz)];
        if (above !== Block.Air) continue;

        const ground = blocks[columnIndex(lx, top, lz)];
        const worldX = originX + lx;
        const worldZ = originZ + lz;
        const h = hash2i(worldX ^ this.seed, worldZ);
        const r1 = (h & 0xffff) / 65535;
        const r2 = ((h >>> 16) & 0xffff) / 65535;

        // Exactly one snow layer, unconditionally, on every land column of a
        // snowy biome. Skipping columns that already end in snow is what
        // pitted the surface; no snowy biome uses snow as its surface material
        // any more, so this branch now fires uniformly.
        if (def.snowy && ground !== Block.Water) {
          blocks[columnIndex(lx, top + 1, lz)] = Block.SnowBlock;
          continue;
        }

        if (ground !== Block.GrassBlock && ground !== Block.Podzol) {
          if (ground === Block.Sand && def.id === Biome.Desert && r1 < 0.004) {
            blocks[columnIndex(lx, top + 1, lz)] = Block.DeadBush;
          }
          continue;
        }

        if (r1 < def.flowerDensity) {
          const flower = r2 < 0.34 ? Block.FlowerRed
            : r2 < 0.67 ? Block.FlowerYellow
              : Block.FlowerBlue;
          blocks[columnIndex(lx, top + 1, lz)] = flower;
        } else if (r1 < def.flowerDensity + def.grassDensity) {
          const isTaiga = def.id === Biome.Taiga || def.id === Biome.SnowyTaiga;
          blocks[columnIndex(lx, top + 1, lz)] =
            isTaiga && r2 < 0.5 ? Block.Fern : Block.TallGrass;
        }
      }
    }
  }

  /** Recomputes both heightmaps after decoration has added blocks. */
  private finishHeightmaps(
    blocks: Uint8Array, heightmap: Int16Array, solidHeightmap: Int16Array,
  ): void {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const area = lz * CHUNK_SIZE + lx;
        let top = -1;
        let solid = -1;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const b = blocks[columnIndex(lx, y, lz)];
          if (b === Block.Air) continue;
          if (top < 0) top = y;
          // Water and foliage let skylight through, so they must not seed the
          // skylight column as if they were a roof.
          if (b !== Block.Water && b !== Block.TallGrass && b !== Block.Fern &&
            b !== Block.FlowerRed && b !== Block.FlowerYellow && b !== Block.FlowerBlue &&
            b !== Block.DeadBush && b !== Block.Glass) {
            solid = y;
            break;
          }
        }
        heightmap[area] = top;
        solidHeightmap[area] = solid;
      }
    }
  }
}

/**
 * Voxel global illumination: a coarse grid of bounced light around the player.
 *
 * This is the one place where being a voxel engine is an outright advantage. A
 * conventional renderer that wants indirect light has to build a voxel
 * structure of the scene first — that is what voxel cone tracing spends its
 * time on. Here the world already *is* that structure, in shared memory, with
 * skylight already flood-filled through it by `lighting.ts`.
 *
 * What the grid holds, per cell of 4x4x4 blocks, is **the colour of the light
 * arriving there as a fraction of sky radiance** — not an absolute brightness.
 * The shader multiplies it by the sky colour of the moment, so one bake serves
 * every hour of the day: a red cliff bounces red at noon and at sunset, and the
 * sunset one is redder because the sky is.
 *
 * Two passes:
 *
 *   1. **Seed.** Each cell samples eight of its sixty-four voxels: how much of
 *      it is solid, what colour that solid is, and how much sky reaches the air
 *      between. A cell that is half stone in daylight emits stone-coloured
 *      light; a cell of open air emits nothing but lets light through.
 *   2. **Propagate.** Six averaging passes over the grid, gated by how open
 *      each cell is. Light spreads out of the ground and along corridors, and
 *      stops at rock — which is what makes a cave dark and a clearing bright
 *      without tracing a single ray.
 *
 * The whole thing is a few hundred thousand array reads, which is why it can
 * afford to be rebuilt from scratch rather than patched incrementally.
 */

import { BLOCK_ALBEDO, BLOCK_FLAGS, Block, BlockFlag } from './blocks.ts';
import { CHUNK_MASK, CHUNK_SIZE, WORLD_HEIGHT, columnIndex } from './constants.ts';
import type { ColumnStore } from './storage.ts';

/** Blocks per cell along each axis. */
export const GI_CELL = 4;
/** Cells across, horizontally. 48 cells = 192 blocks, toroidal. */
export const GI_SIZE_XZ = 48;
/** Cells vertically — the whole world, so there is no vertical wrap or seam. */
export const GI_SIZE_Y = WORLD_HEIGHT / GI_CELL;

const CELL_COUNT = GI_SIZE_XZ * GI_SIZE_Y * GI_SIZE_XZ;

/** Voxels sampled per cell along each axis: every other one. */
const SAMPLE_STRIDE = 2;
const SAMPLES_PER_CELL = (GI_CELL / SAMPLE_STRIDE) ** 3;

/** Passes of neighbour averaging. More spreads further and costs linearly. */
const PROPAGATION_PASSES = 6;
/** How much of a neighbour's light reaches a cell. Below 1, or it never ends. */
const TRANSFER = 0.62;
/** Sky light that a surface bounces rather than absorbs, on top of its albedo. */
const BOUNCE = 1.35;

/**
 * Texel order for `texImage3D`: x fastest, then y, then z. Building straight
 * into that order saves a repack of three quarters of a megabyte.
 */
const texelIndex = (x: number, y: number, z: number): number =>
  (z * GI_SIZE_Y + y) * GI_SIZE_XZ + x;

/** Positive modulo, for the toroidal horizontal wrap. */
const wrap = (v: number): number => ((v % GI_SIZE_XZ) + GI_SIZE_XZ) % GI_SIZE_XZ;

export interface GiResult {
  /** RGBA8, ready for `texImage3D`. */
  data: Uint8Array;
  /** World cell coordinate of the grid's corner, for the shader's addressing. */
  originCellX: number;
  originCellZ: number;
}

export class GiBuilder {
  /** Light emitted by each cell itself, RGB. */
  private readonly emission = new Float32Array(CELL_COUNT * 3);
  /** Current and next iteration of propagated light. */
  private light = new Float32Array(CELL_COUNT * 3);
  private next = new Float32Array(CELL_COUNT * 3);
  /** 0 = solid rock, 1 = open air. Gates both propagation and the result. */
  private readonly open = new Float32Array(CELL_COUNT);
  /**
   * Cells the propagation bothers with.
   *
   * Open sky well above the terrain is excluded: it holds no bounced light and
   * never will, the shader reads the sky itself for what comes from up there,
   * and it is half the grid. Cells within a couple of cells of the surface stay
   * active, so light still travels over a cliff edge.
   */
  private readonly active = new Uint8Array(CELL_COUNT);

  /**
   * Rebuilds the whole grid around a cell-aligned origin.
   *
   * Returns a fresh buffer every call because the result is transferred to the
   * main thread, which takes ownership of it.
   */
  build(store: ColumnStore, originCellX: number, originCellZ: number): GiResult {
    this.seed(store, originCellX, originCellZ);
    this.propagate();
    return {
      data: this.pack(),
      originCellX,
      originCellZ,
    };
  }

  // -------------------------------------------------------------------------

  private seed(store: ColumnStore, originCellX: number, originCellZ: number): void {
    this.emission.fill(0);
    this.open.fill(0);
    this.active.fill(0);

    for (let cz = 0; cz < GI_SIZE_XZ; cz++) {
      const worldCellZ = originCellZ + cz;
      const blockZ = worldCellZ * GI_CELL;
      const tz = wrap(worldCellZ);

      for (let cx = 0; cx < GI_SIZE_XZ; cx++) {
        const worldCellX = originCellX + cx;
        const blockX = worldCellX * GI_CELL;
        const tx = wrap(worldCellX);

        // A cell is 4 blocks and a column is 32, both powers of two, so a cell
        // never straddles two columns: one lookup serves the whole vertical
        // stack and every voxel below can be indexed directly.
        const column = store.get(blockX >> 5, blockZ >> 5);
        if (!column) continue;

        const blocks = column.blocks;
        const lightBytes = column.light;
        const localX = blockX & CHUNK_MASK;
        const localZ = blockZ & CHUNK_MASK;

        const grassTint = column.grassTint;
        const foliageTint = column.foliageTint;
        const tintIndex = (localZ * CHUNK_SIZE + localX) * 3;

        // Highest non-air block anywhere in this cell's footprint. Everything
        // above it is open sky by definition, and that is most of the grid: the
        // world is 192 blocks tall and its terrain tops out around 90. Skipping
        // those cells' inner loop is the single biggest saving in the bake.
        let top = -1;
        for (let dz = 0; dz < GI_CELL; dz++) {
          const row = (localZ + dz) * CHUNK_SIZE + localX;
          for (let dx = 0; dx < GI_CELL; dx++) {
            const h = column.heightmap[row + dx];
            if (h > top) top = h;
          }
        }

        for (let cy = 0; cy < GI_SIZE_Y; cy++) {
          const blockY = cy * GI_CELL;

          if (blockY > top) {
            // Open sky: nothing to bounce off, and light passes through freely.
            const skyCell = texelIndex(tx, cy, tz);
            this.open[skyCell] = 1;
            // Two cells of margin: bounced light still has to be able to cross
            // a cliff edge, where the neighbouring column's terrain is higher.
            if (blockY <= top + GI_CELL * 2) this.active[skyCell] = 1;
            continue;
          }

          let solidCount = 0;
          let airCount = 0;
          let skySum = 0;
          let ar = 0;
          let ag = 0;
          let ab = 0;

          for (let dy = 0; dy < GI_CELL; dy += SAMPLE_STRIDE) {
            for (let dz = 0; dz < GI_CELL; dz += SAMPLE_STRIDE) {
              for (let dx = 0; dx < GI_CELL; dx += SAMPLE_STRIDE) {
                const index = columnIndex(localX + dx, blockY + dy, localZ + dz);
                const id = blocks[index];

                if ((BLOCK_FLAGS[id] & BlockFlag.Opaque) !== 0) {
                  solidCount++;
                  let r = BLOCK_ALBEDO[id * 3];
                  let g = BLOCK_ALBEDO[id * 3 + 1];
                  let b = BLOCK_ALBEDO[id * 3 + 2];

                  // Biome-tinted blocks bounce their tinted colour, and the
                  // tint is per column — the same rule the mesher follows.
                  if ((BLOCK_FLAGS[id] & BlockFlag.BiomeTinted) !== 0) {
                    const tint = id === Block.GrassBlock ? grassTint : foliageTint;
                    // Authored as sRGB, used as reflectance; square is a close
                    // enough decode for a grid this coarse.
                    const tr = tint[tintIndex] / 255;
                    const tg = tint[tintIndex + 1] / 255;
                    const tb = tint[tintIndex + 2] / 255;
                    r *= tr * tr;
                    g *= tg * tg;
                    b *= tb * tb;
                  }

                  ar += r;
                  ag += g;
                  ab += b;
                } else {
                  airCount++;
                  skySum += lightBytes[index] >> 4;
                }
              }
            }
          }

          const cell = texelIndex(tx, cy, tz);
          this.open[cell] = airCount / SAMPLES_PER_CELL;
          this.active[cell] = 1;

          if (solidCount === 0 || airCount === 0) continue;

          // Light reaching the air in this cell, bounced off the solid in it.
          // `ar` is a sum over the solid samples, so dividing by the sample
          // count folds in what fraction of the cell is solid at all.
          const sky = (skySum / airCount) / 15;
          const scale = (sky * BOUNCE) / SAMPLES_PER_CELL;
          const e = cell * 3;
          this.emission[e] = ar * scale;
          this.emission[e + 1] = ag * scale;
          this.emission[e + 2] = ab * scale;
        }
      }
    }
  }

  private propagate(): void {
    this.light.fill(0);

    const strideY = GI_SIZE_XZ;

    // Hoisted out of the loop on purpose: this runs six times over a hundred
    // thousand cells, and a property load per neighbour shows up in the total.
    const open = this.open;
    const emission = this.emission;
    const active = this.active;

    for (let pass = 0; pass < PROPAGATION_PASSES; pass++) {
      const from = this.light;
      const to = this.next;

      for (let z = 0; z < GI_SIZE_XZ; z++) {
        for (let y = 0; y < GI_SIZE_Y; y++) {
          for (let x = 0; x < GI_SIZE_XZ; x++) {
            const cell = (z * GI_SIZE_Y + y) * GI_SIZE_XZ + x;
            const openness = open[cell];
            const o = cell * 3;

            if (active[cell] === 0 || openness <= 0.001) {
              to[o] = 0;
              to[o + 1] = 0;
              to[o + 2] = 0;
              continue;
            }

            let r = 0;
            let g = 0;
            let b = 0;

            // Six neighbours, each weighted by how open it is. The horizontal
            // axes wrap with the grid; the vertical ones simply stop, which is
            // correct — there is nothing above the sky or below bedrock.
            const xm = (z * GI_SIZE_Y + y) * GI_SIZE_XZ + (x === 0 ? GI_SIZE_XZ - 1 : x - 1);
            const xp = (z * GI_SIZE_Y + y) * GI_SIZE_XZ + (x === GI_SIZE_XZ - 1 ? 0 : x + 1);
            const zm = (((z === 0 ? GI_SIZE_XZ - 1 : z - 1) * GI_SIZE_Y) + y) * GI_SIZE_XZ + x;
            const zp = (((z === GI_SIZE_XZ - 1 ? 0 : z + 1) * GI_SIZE_Y) + y) * GI_SIZE_XZ + x;

            // Unrolled on purpose: this is the inner loop of the whole bake,
            // and an array of neighbours here allocates a million times over.
            let w = open[xm];
            let i = xm * 3;
            r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;

            w = open[xp];
            i = xp * 3;
            r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;

            w = open[zm];
            i = zm * 3;
            r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;

            w = open[zp];
            i = zp * 3;
            r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;

            if (y > 0) {
              const n = cell - strideY;
              w = open[n];
              i = n * 3;
              r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;
            }
            if (y < GI_SIZE_Y - 1) {
              const n = cell + strideY;
              w = open[n];
              i = n * 3;
              r += from[i] * w; g += from[i + 1] * w; b += from[i + 2] * w;
            }

            const k = (TRANSFER / 6) * openness;
            to[o] = emission[o] + r * k;
            to[o + 1] = emission[o + 1] + g * k;
            to[o + 2] = emission[o + 2] + b * k;
          }
        }
      }

      this.light = to;
      this.next = from;
    }
  }

  private pack(): Uint8Array {
    // A fresh buffer every bake: the result is transferred to the main thread,
    // which takes ownership of it.
    const out = new Uint8Array(CELL_COUNT * 4);
    const light = this.light;

    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const i = cell * 3;
      const o = cell * 4;
      out[o] = Math.min(255, light[i] * 255);
      out[o + 1] = Math.min(255, light[i + 1] * 255);
      out[o + 2] = Math.min(255, light[i + 2] * 255);
      // Openness rides along in alpha: the shader uses it to fade the grid out
      // inside geometry, where a trilinear tap would otherwise pull light from
      // the rock a texel away.
      out[o + 3] = Math.round(this.open[cell] * 255);
    }

    return out;
  }
}

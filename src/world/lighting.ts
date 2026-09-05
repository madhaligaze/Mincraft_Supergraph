/**
 * Baked light propagation.
 *
 * Two channels are flood-filled per column:
 *
 *  - **Skylight** — how much of the sky a voxel can see. With a real
 *    directional sun and cascaded shadow maps doing the direct lighting, this
 *    channel is not "the sun"; it is the ambient/indirect visibility term, and
 *    it is what makes a cave mouth darken smoothly instead of switching off.
 *  - **Block light** — emission from glowstone and lava, used for the ambient
 *    contribution. Nearby emitters are *also* submitted as real point lights by
 *    the renderer, so this channel only has to carry the soft falloff.
 *
 * The fill runs over the target column plus a 4-block skirt read from its
 * neighbours, which is what keeps a chunk border from showing as a seam under
 * an overhang. Results are written only into the target column, so parallel
 * workers never write to the same memory.
 */

import {
  CHUNK_SIZE, WORLD_HEIGHT, columnIndex, MAX_LIGHT,
} from './constants.ts';
import { BLOCK_ATTENUATION, BLOCK_FLAGS, BLOCK_LIGHT, BlockFlag } from './blocks.ts';
import type { ColumnData, ColumnStore } from './storage.ts';

/** Blocks of neighbour data pulled in around the column being lit. */
const PAD = 4;
const REGION = CHUNK_SIZE + PAD * 2; // 40
const REGION_AREA = REGION * REGION;

export class LightSolver {
  /** Skylight and block light for the padded region, one byte each. */
  private readonly sky = new Uint8Array(REGION_AREA * WORLD_HEIGHT);
  private readonly block = new Uint8Array(REGION_AREA * WORLD_HEIGHT);
  /** Block ids gathered from the nine columns, so the fill never re-dispatches. */
  private readonly blocks = new Uint8Array(REGION_AREA * WORLD_HEIGHT);
  /** Top opaque block per region column. */
  private readonly tops = new Int16Array(REGION_AREA);

  /**
   * FIFO of region indices. Sized for the whole region so a pathological cave
   * system can never overflow it; in practice only a few thousand entries are
   * ever live.
   */
  private queue = new Int32Array(1 << 18);
  private queueHead = 0;
  private queueTail = 0;

  /** Region-x -> (neighbour dx, local x) lookup, built once. */
  private readonly mapDX = new Int8Array(REGION);
  private readonly mapLX = new Uint8Array(REGION);

  /** Highest y that needs to be processed for the current column. */
  private topY = 0;

  constructor() {
    for (let r = 0; r < REGION; r++) {
      const world = r - PAD;
      this.mapDX[r] = world < 0 ? -1 : world >= CHUNK_SIZE ? 1 : 0;
      this.mapLX[r] = world < 0 ? world + CHUNK_SIZE : world >= CHUNK_SIZE ? world - CHUNK_SIZE : world;
    }
  }

  /**
   * Computes both light channels for column (cx, cz).
   * Requires every neighbour in the 3x3 block to be generated.
   */
  solve(store: ColumnStore, cx: number, cz: number): void {
    const target = store.get(cx, cz);
    if (!target) return;

    this.gather(store, cx, cz);
    this.seedSkylight();
    this.propagate(this.sky);
    this.seedBlockLight();
    this.propagate(this.block);
    this.writeBack(target);

    target.lit = true;
  }

  /** Copies block ids from the nine columns into the flat region buffer. */
  private gather(store: ColumnStore, cx: number, cz: number): void {
    const neighbours: Array<ColumnData | undefined> = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        neighbours.push(store.get(cx + dx, cz + dz));
      }
    }
    const columnAt = (dx: number, dz: number): ColumnData | undefined =>
      neighbours[(dz + 1) * 3 + (dx + 1)];

    // Highest opaque block anywhere in the region bounds the work.
    let maxTop = 0;

    for (let rz = 0; rz < REGION; rz++) {
      const dz = this.mapDX[rz];
      const lz = this.mapLX[rz];
      for (let rx = 0; rx < REGION; rx++) {
        const dx = this.mapDX[rx];
        const lx = this.mapLX[rx];
        const column = columnAt(dx, dz);
        const areaIndex = rz * REGION + rx;

        if (!column) {
          // Missing neighbour: treat as empty sky so the border stays bright
          // rather than casting a false shadow.
          this.tops[areaIndex] = -1;
          continue;
        }

        const top = column.solidHeightmap[lz * CHUNK_SIZE + lx];
        this.tops[areaIndex] = top;
        if (top > maxTop) maxTop = top;
      }
    }

    this.topY = Math.min(WORLD_HEIGHT - 1, maxTop + 1);

    // Second pass copies only the y range that matters.
    for (let rz = 0; rz < REGION; rz++) {
      const dz = this.mapDX[rz];
      const lz = this.mapLX[rz];
      for (let rx = 0; rx < REGION; rx++) {
        const dx = this.mapDX[rx];
        const lx = this.mapLX[rx];
        const column = columnAt(dx, dz);
        const areaIndex = rz * REGION + rx;

        if (!column) {
          for (let y = 0; y <= this.topY; y++) {
            this.blocks[y * REGION_AREA + areaIndex] = 0;
          }
          continue;
        }

        const src = column.blocks;
        for (let y = 0; y <= this.topY; y++) {
          this.blocks[y * REGION_AREA + areaIndex] = src[columnIndex(lx, y, lz)];
        }
      }
    }

    // Clear the working channels over the active range only.
    const active = (this.topY + 1) * REGION_AREA;
    this.sky.fill(0, 0, active);
    this.block.fill(0, 0, active);
  }

  private resetQueue(): void {
    this.queueHead = 0;
    this.queueTail = 0;
  }

  private push(index: number): void {
    if (this.queueTail >= this.queue.length) {
      const grown = new Int32Array(this.queue.length * 2);
      grown.set(this.queue);
      this.queue = grown;
    }
    this.queue[this.queueTail++] = index;
  }

  /**
   * Vertical seeding: a column is fully lit down to the first opaque block,
   * losing `lightAttenuation` levels through anything translucent on the way.
   */
  private seedSkylight(): void {
    this.resetQueue();
    const { sky, blocks } = this;

    for (let rz = 0; rz < REGION; rz++) {
      for (let rx = 0; rx < REGION; rx++) {
        const areaIndex = rz * REGION + rx;
        let level = MAX_LIGHT;

        for (let y = this.topY; y >= 0; y--) {
          const index = y * REGION_AREA + areaIndex;
          const id = blocks[index];

          if (BLOCK_FLAGS[id] & BlockFlag.Opaque) {
            level = 0;
            // Everything below an opaque block starts dark; the flood fill
            // will bring light back in through side openings.
            break;
          }

          const attenuation = BLOCK_ATTENUATION[id];
          if (attenuation > 0 && id !== 0) {
            level = Math.max(0, level - attenuation);
          }

          sky[index] = level;
          if (level > 1) this.push(index);
          if (level === 0) break;
        }
      }
    }
  }

  private seedBlockLight(): void {
    this.resetQueue();
    const { block, blocks } = this;

    for (let y = 0; y <= this.topY; y++) {
      const base = y * REGION_AREA;
      for (let i = 0; i < REGION_AREA; i++) {
        const emission = BLOCK_LIGHT[blocks[base + i]];
        if (emission > 0) {
          block[base + i] = emission;
          this.push(base + i);
        }
      }
    }
  }

  /**
   * Standard 6-neighbour BFS. Because seeds are pushed in descending order and
   * every step decreases the level by at least one, a plain FIFO visits each
   * cell at most a small constant number of times.
   */
  private propagate(channel: Uint8Array): void {
    const { blocks } = this;
    const maxIndex = (this.topY + 1) * REGION_AREA;

    while (this.queueHead < this.queueTail) {
      const index = this.queue[this.queueHead++];
      const level = channel[index];
      if (level <= 1) continue;

      const y = (index / REGION_AREA) | 0;
      const rest = index - y * REGION_AREA;
      const rz = (rest / REGION) | 0;
      const rx = rest - rz * REGION;

      // -X, +X, -Z, +Z, -Y, +Y
      if (rx > 0) this.step(channel, blocks, index - 1, level, maxIndex);
      if (rx < REGION - 1) this.step(channel, blocks, index + 1, level, maxIndex);
      if (rz > 0) this.step(channel, blocks, index - REGION, level, maxIndex);
      if (rz < REGION - 1) this.step(channel, blocks, index + REGION, level, maxIndex);
      if (y > 0) this.step(channel, blocks, index - REGION_AREA, level, maxIndex);
      if (y < this.topY) this.step(channel, blocks, index + REGION_AREA, level, maxIndex);
    }

    // Periodically compact the queue so repeated solves do not grow it forever.
    if (this.queueTail > (1 << 20)) this.queue = new Int32Array(1 << 18);
  }

  private step(
    channel: Uint8Array, blocks: Uint8Array,
    index: number, level: number, maxIndex: number,
  ): void {
    if (index < 0 || index >= maxIndex) return;
    const id = blocks[index];
    if (BLOCK_FLAGS[id] & BlockFlag.Opaque) return;

    const cost = 1 + (id !== 0 ? BLOCK_ATTENUATION[id] : 0);
    const next = level - cost;
    if (next <= channel[index]) return;

    channel[index] = next;
    this.push(index);
  }

  /** Packs the two channels into the column's light array. */
  private writeBack(target: ColumnData): void {
    const { sky, block, light } = { sky: this.sky, block: this.block, light: target.light };

    for (let y = 0; y <= this.topY; y++) {
      const regionBase = y * REGION_AREA;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const regionRow = regionBase + (lz + PAD) * REGION + PAD;
        const columnRow = (y << 10) | (lz << 5);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          light[columnRow + lx] = (sky[regionRow + lx] << 4) | block[regionRow + lx];
        }
      }
    }

    // Everything above the processed range sees full sky.
    for (let y = this.topY + 1; y < WORLD_HEIGHT; y++) {
      light.fill(0xf0, y << 10, (y << 10) + CHUNK_SIZE * CHUNK_SIZE);
    }
  }
}

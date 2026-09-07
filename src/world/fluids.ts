/**
 * Fluid flow.
 *
 * Until this existed, water was scenery: an ocean was a solid block of source
 * cells that never moved, and digging a tunnel under the sea left a dry hole
 * with a flat pane of water hanging over it. That is the single most visible
 * way a voxel world stops behaving like Minecraft, because water is the first
 * thing a player interacts with that is supposed to be *alive*.
 *
 * The model is Minecraft's, and it is worth stating plainly because it is much
 * simpler than a fluid solver and produces behaviour players already know:
 *
 *   * A cell holds either a source or a flow at level 1..7 (1..3 for lava).
 *     Level is the block id — see `Block.WaterFlow1` and the note there.
 *   * A cell's level is one more than the shallowest fluid neighbour's, so
 *     level counts distance from a source and the flow thins as it runs.
 *   * Past the fluid's range — seven for water, three for lava — nothing
 *     arrives and the cell dries out. That, and only that, is what stops a
 *     spill from covering the world.
 *   * Fluid above a cell pours straight into it at full strength, so a fall is
 *     not weakened by height.
 *   * A cell that can fall does not feed its horizontal neighbours. This one
 *     rule is what makes water pour into a hole instead of spreading around it.
 *   * Two adjacent sources make a third. This is what refills a hole dug under
 *     the sea and — the part that matters — keeps it refilled.
 *
 * Everything is driven by a work queue rather than by scanning the world.
 * Cells enter it when something next to them changes, so a still ocean costs
 * exactly nothing, and a spill costs work proportional to the spill.
 */

import {
  Block, BLOCK_FLAGS, BlockFlag,
  FLUID_KIND, FLUID_LEVEL, FLUID_FLOWING, FLUID_RANGE, FLUID_SOURCE,
  FLUID_WATER, FLUID_LAVA, NOT_FLUID, isWashable,
} from './blocks.ts';
import { WORLD_HEIGHT } from './constants.ts';

/** Seconds between water updates. Minecraft runs water every five game ticks. */
const WATER_PERIOD = 0.2;
/** Lava crawls: the difference is most of what makes it feel dangerous. */
const LAVA_PERIOD = 0.6;

/**
 * Cells evaluated per tick.
 *
 * Each change re-meshes a section, so the ceiling is not the arithmetic — that
 * is trivial — but the meshing behind it. Two hundred is far more than any
 * ordinary spill needs and still bounded well below a frame.
 */
const BUDGET = 224;

/** Beyond this the queue is dropped rather than grown; see `schedule`. */
const MAX_QUEUE = 40000;

/**
 * Packs a world cell into one number.
 *
 * Y is eight bits and X and Z twenty-one each, which is fifty bits — exactly
 * representable in a double, so a plain `Set<number>` deduplicates cells with
 * no allocation and no string keys.
 */
const OFFSET = 1 << 20;      // 2^20
const Z_STRIDE = 1 << 8;     // y occupies the low eight bits
const X_STRIDE = 1 << 29;    // ...and z the twenty-one above it
const Z_SPAN = 1 << 21;

const packCell = (x: number, y: number, z: number): number =>
  ((x + OFFSET) * Z_SPAN + (z + OFFSET)) * Z_STRIDE + y;
const cellY = (key: number): number => key % Z_STRIDE;
const cellZ = (key: number): number => Math.floor(key / Z_STRIDE) % Z_SPAN - OFFSET;
const cellX = (key: number): number => Math.floor(key / X_STRIDE) - OFFSET;

/** What the simulation needs from the world. */
export interface FluidWorld {
  getBlock(x: number, y: number, z: number): number;
  /**
   * Writes a block without relighting the column immediately.
   * Returns false when the cell is not in a loaded, lit chunk.
   */
  setFluidBlock(x: number, y: number, z: number, block: number): boolean;
  /** Relights and re-meshes everything a batch of writes touched. */
  flushFluidBlocks(): void;
  /** Whether the cell's column exists at all, loaded or still generating. */
  hasColumnAt(x: number, z: number): boolean;
}

export class FluidSim {
  private queue = new Set<number>();
  private waterTimer = 0;
  private lavaTimer = 0;

  /** Cells evaluated since the last `resetStats`, for the debug overlay. */
  stats = { queued: 0, evaluated: 0, changed: 0 };

  constructor(private readonly world: FluidWorld) {}

  /**
   * Marks a cell and its six neighbours for re-evaluation.
   *
   * Called from every block edit. The neighbours matter as much as the cell:
   * removing a block is a change to the *space*, and it is the water beside it
   * that has to notice.
   */
  schedule(x: number, y: number, z: number): void {
    if (this.queue.size > MAX_QUEUE) return;
    this.add(x, y, z);
    this.add(x + 1, y, z);
    this.add(x - 1, y, z);
    this.add(x, y, z + 1);
    this.add(x, y, z - 1);
    this.add(x, y + 1, z);
    this.add(x, y - 1, z);
  }

  private add(x: number, y: number, z: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    this.queue.add(packCell(x, y, z));
  }

  get pending(): number {
    return this.queue.size;
  }

  update(dt: number): void {
    this.waterTimer += dt;
    this.lavaTimer += dt;

    const waterTick = this.waterTimer >= WATER_PERIOD;
    const lavaTick = this.lavaTimer >= LAVA_PERIOD;
    if (!waterTick) return;

    this.waterTimer = 0;
    if (lavaTick) this.lavaTimer = 0;

    if (this.queue.size === 0) return;

    // Snapshot the queue and start a fresh one: changes made during this tick
    // schedule their neighbours for the *next* tick, which is what gives a
    // flow its visible one-block-per-tick advance instead of resolving the
    // whole spill inside a single frame.
    const batch = this.queue;
    this.queue = new Set<number>();

    let budget = BUDGET;
    for (const key of batch) {
      if (budget <= 0) {
        // Everything not reached this tick carries over.
        this.queue.add(key);
        continue;
      }
      budget--;
      this.stats.evaluated++;

      const x = cellX(key);
      const y = cellY(key);
      const z = cellZ(key);

      const target = this.evaluate(x, y, z);
      if (target < 0) continue;

      const current = this.world.getBlock(x, y, z);
      if (target === current) continue;

      // Lava moves on its own, slower clock. Holding the cell back rather than
      // dropping it is what keeps the queue authoritative.
      if (!lavaTick && FLUID_KIND[target] === FLUID_LAVA) {
        this.queue.add(key);
        continue;
      }

      if (!this.world.setFluidBlock(x, y, z, target)) {
        // The column is mid-generation. Come back to it rather than dropping
        // the change: a cell that cannot be written *yet* is not a cell that
        // should stay dry. Cells in columns that do not exist are dropped,
        // which is what keeps the queue from growing without bound as the
        // player walks away from a spill.
        if (this.world.hasColumnAt(x, z)) this.queue.add(key);
        continue;
      }
      this.stats.changed++;
      this.schedule(x, y, z);
    }

    this.stats.queued = this.queue.size;
    this.world.flushFluidBlocks();
  }

  /**
   * What this cell should hold, or -1 to leave it alone.
   *
   * Pure with respect to the world: it only reads. Applying the answer is the
   * caller's job, which keeps the rule readable and makes it testable.
   */
  private evaluate(x: number, y: number, z: number): number {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    const kind = FLUID_KIND[id];
    const level = FLUID_LEVEL[id];

    // Solid ground is not this simulation's business.
    if (kind === 0 && !isWashable(id)) return -1;

    // --- lava meeting water ---
    // Checked before anything else, and for sources too: this is the one rule
    // that consumes a source, and it is the reason a lava flow into the sea
    // builds land instead of boiling forever.
    if (kind === FLUID_LAVA) {
      if (this.touchesWater(x, y, z)) {
        return level === 0 ? Block.Stone : Block.Cobblestone;
      }
      return -1;
    }

    // A source persists until something solid replaces it, and that goes
    // through the ordinary block edit path rather than through here.
    if (kind !== 0 && level === 0) return -1;

    // --- what arrives ---
    let bestKind = 0;
    let bestLevel = NOT_FLUID;

    // Fluid directly above pours in at full strength: a waterfall does not
    // thin out with the height it fell.
    const aboveKind = FLUID_KIND[world.getBlock(x, y + 1, z)];
    if (aboveKind !== 0) {
      bestKind = aboveKind;
      bestLevel = 1;
    }

    let waterSources = 0;

    for (let i = 0; i < 4; i++) {
      const nx = x + (i === 0 ? 1 : i === 1 ? -1 : 0);
      const nz = z + (i === 2 ? 1 : i === 3 ? -1 : 0);
      const nb = world.getBlock(nx, y, nz);
      const nk = FLUID_KIND[nb];
      if (nk === 0) continue;

      const nl = FLUID_LEVEL[nb];
      if (nl === 0 && nk === FLUID_WATER) waterSources++;

      // A neighbour with somewhere to fall pours downward instead of feeding
      // sideways. Without this a stream spreads into a puddle around the hole
      // it should be pouring into.
      if (isWashable(world.getBlock(nx, y - 1, nz))) continue;

      const candidate = nl + 1;
      if (candidate < bestLevel) {
        bestLevel = candidate;
        bestKind = nk;
      }
    }

    // Two adjacent sources make a third. The rule reads like a curiosity and is
    // load-bearing: it is why a hole dug under the sea fills and stays filled
    // rather than draining the ocean one cell at a time.
    if (waterSources >= 2) return Block.Water;

    if (bestKind === 0 || bestLevel > FLUID_RANGE[bestKind]) {
      // Nothing reaches here. A cell that held fluid dries out; a cell that was
      // already empty needs no write.
      return kind !== 0 ? Block.Air : -1;
    }

    // Lava arriving where water already is turns to stone on contact.
    if (bestKind === FLUID_LAVA && this.touchesWater(x, y, z)) return Block.Cobblestone;

    return FLUID_FLOWING[bestKind][bestLevel - 1];
  }

  private touchesWater(x: number, y: number, z: number): boolean {
    const w = this.world;
    return FLUID_KIND[w.getBlock(x + 1, y, z)] === FLUID_WATER ||
      FLUID_KIND[w.getBlock(x - 1, y, z)] === FLUID_WATER ||
      FLUID_KIND[w.getBlock(x, y, z + 1)] === FLUID_WATER ||
      FLUID_KIND[w.getBlock(x, y, z - 1)] === FLUID_WATER ||
      FLUID_KIND[w.getBlock(x, y + 1, z)] === FLUID_WATER;
  }
}

/**
 * The source block a player places for a fluid, given any block of it.
 *
 * The hotbar holds `Water`; breaking a flow yields nothing. This exists so the
 * rest of the engine can ask "which fluid is this" without knowing about
 * levels.
 */
export function fluidSourceOf(id: number): number {
  const kind = FLUID_KIND[id];
  return kind === 0 ? Block.Air : FLUID_SOURCE[kind];
}

/** Whether a block is water in any form, source or flow. */
export function isWater(id: number): boolean {
  return FLUID_KIND[id] === FLUID_WATER;
}

/** Whether a block is lava in any form. */
export function isLava(id: number): boolean {
  return FLUID_KIND[id] === FLUID_LAVA;
}

/** Whether the player takes contact damage from this block. */
export function isHarmful(id: number): boolean {
  return (BLOCK_FLAGS[id] & BlockFlag.Harmful) !== 0;
}

/**
 * How the world answers back when you dig.
 *
 * Two reactions, one scheduler, because they are the same shape: an edit
 * happens, some cells nearby stop being valid, and they have to be fixed on a
 * clock rather than inside the edit that caused them.
 *
 * **Falling blocks.** Sand and gravel with nothing underneath fall. Without it
 * a tunnel under a beach is a tunnel with a sand ceiling, and the one thing
 * every player knows about sand — that digging up into it buries you — is
 * missing.
 *
 * **Leaf decay.** Fell a tree and the canopy stays in the sky. Minecraft keeps
 * a distance number in each leaf block's metadata; there is no metadata here,
 * so instead one flood fill runs *from the logs that are left* whenever a log
 * is broken, and every leaf the fill did not reach is scheduled to fall apart.
 * One fill per felled log rather than a search per leaf.
 */

import { Block, BLOCK_FLAGS, BlockFlag, hasGravity, isSolid } from '../world/blocks.ts';
import { WORLD_HEIGHT } from '../world/constants.ts';
import type { World } from '../world/world.ts';
import type { ItemEntities } from './entities.ts';
import { dropsFor } from './drops.ts';

/** Seconds between simulation steps. Five a second reads as sliding, not teleporting. */
const STEP = 0.2;

/** How far a leaf may be from a log before it is orphaned. Minecraft's number. */
const LEAF_RANGE = 6;

/** Seconds a leaf hangs on before it goes, spread out so a canopy melts. */
const DECAY_MIN = 0.6;
const DECAY_MAX = 3.5;

const isLeaf = (block: number): boolean =>
  block === Block.OakLeaves || block === Block.BirchLeaves || block === Block.SpruceLeaves;

const isLog = (block: number): boolean =>
  block === Block.OakLog || block === Block.BirchLog || block === Block.SpruceLog;

/** A cell can be fallen into if it is not solid — air, plants, water. */
const isOpenBelow = (block: number): boolean =>
  !isSolid(block) || (BLOCK_FLAGS[block] & BlockFlag.Passable) !== 0;

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

export class WorldReactions {
  /** Cells that might contain a block that should fall. */
  private readonly falling = new Set<string>();
  /** Leaves waiting to decay, and when. */
  private readonly decaying = new Map<string, number>();

  private timer = 0;
  private elapsed = 0;

  constructor(
    private readonly world: World,
    private readonly items: ItemEntities,
  ) {}

  get pending(): number {
    return this.falling.size + this.decaying.size;
  }

  clear(): void {
    this.falling.clear();
    this.decaying.clear();
  }

  /**
   * Every edit in the world passes through here.
   *
   * Cheap on purpose: it decides what to *look at* later, and looks at nothing
   * now. A player mining quickly makes several of these a second, and a flood
   * fill inside each one would be felt.
   */
  onBlockChanged(x: number, y: number, z: number, previous: number, block: number): void {
    // Anything above the edit may now have nothing under it. Two cells up,
    // because the column keeps falling on its own after the first step.
    this.scheduleFall(x, y + 1, z);
    if (hasGravity(block)) this.scheduleFall(x, y, z);

    // A felled log orphans leaves. Only a log going *away* matters: planting
    // one cannot orphan anything.
    if (isLog(previous) && !isLog(block)) this.orphanLeaves(x, y, z);
  }

  scheduleFall(x: number, y: number, z: number): void {
    if (y < 1 || y >= WORLD_HEIGHT) return;
    this.falling.add(key(x, y, z));
  }

  /**
   * Marks every leaf near a felled log that no longer reaches one.
   *
   * The flood fill starts at the logs still standing within range and walks
   * through leaves; anything it does not reach is orphaned. That is one search
   * over the neighbourhood instead of one per leaf, and it gets the interesting
   * case right for free: fell the bottom of a trunk and nothing decays, because
   * the rest of the trunk still holds the canopy.
   */
  private orphanLeaves(x: number, y: number, z: number): void {
    const world = this.world;
    const leaves: string[] = [];
    const logs: Array<[number, number, number]> = [];

    for (let dy = -LEAF_RANGE; dy <= LEAF_RANGE; dy++) {
      for (let dz = -LEAF_RANGE; dz <= LEAF_RANGE; dz++) {
        for (let dx = -LEAF_RANGE; dx <= LEAF_RANGE; dx++) {
          const bx = x + dx, by = y + dy, bz = z + dz;
          if (by < 1 || by >= WORLD_HEIGHT) continue;
          const block = world.getBlock(bx, by, bz);
          if (isLeaf(block)) leaves.push(key(bx, by, bz));
          else if (isLog(block)) logs.push([bx, by, bz]);
        }
      }
    }
    if (leaves.length === 0) return;

    // Flood from the remaining logs, through leaves only.
    const reached = new Set<string>();
    const queue: Array<[number, number, number, number]> = [];
    for (const [lx, ly, lz] of logs) queue.push([lx, ly, lz, 0]);

    while (queue.length > 0) {
      const [cx, cy, cz, distance] = queue.pop()!;
      if (distance >= LEAF_RANGE) continue;
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (ny < 1 || ny >= WORLD_HEIGHT) continue;
        const k = key(nx, ny, nz);
        if (reached.has(k)) continue;
        if (!isLeaf(world.getBlock(nx, ny, nz))) continue;
        reached.add(k);
        queue.push([nx, ny, nz, distance + 1]);
      }
    }

    for (const k of leaves) {
      if (reached.has(k) || this.decaying.has(k)) continue;
      this.decaying.set(k, this.elapsed + DECAY_MIN + Math.random() * (DECAY_MAX - DECAY_MIN));
    }
  }

  /**
   * One fixed step, whatever the frame rate — the same shape as the fluid
   * simulation's clock, and for the same reason: a mechanic that runs faster on
   * a faster machine is a different game.
   */
  update(dt: number): void {
    this.elapsed += dt;
    this.timer += dt;
    if (this.timer < STEP) return;
    this.timer = 0;

    this.stepFalling();
    this.stepDecay();
    this.world.flushFluidBlocks();
  }

  private stepFalling(): void {
    if (this.falling.size === 0) return;
    const world = this.world;
    const cells = [...this.falling];
    this.falling.clear();

    for (const cell of cells) {
      const [x, y, z] = cell.split(',').map(Number);
      const block = world.getBlock(x, y, z);
      if (!hasGravity(block)) continue;

      const below = world.getBlock(x, y - 1, z);
      if (!isOpenBelow(below)) continue;

      // Moved with the batched writer, not `setBlock`: a falling column is
      // several cells a step and a full-column relight for each one is the
      // cost the fluid simulation already ran into.
      world.setFluidBlock(x, y, z, Block.Air);
      world.setFluidBlock(x, y - 1, z, block);

      // Keep going, and let whatever was above notice too.
      this.scheduleFall(x, y - 1, z);
      this.scheduleFall(x, y + 1, z);
    }
  }

  private stepDecay(): void {
    if (this.decaying.size === 0) return;
    const world = this.world;

    for (const [cell, due] of this.decaying) {
      if (due > this.elapsed) continue;
      this.decaying.delete(cell);

      const [x, y, z] = cell.split(',').map(Number);
      const block = world.getBlock(x, y, z);
      if (!isLeaf(block)) continue;

      world.setFluidBlock(x, y, z, Block.Air);
      // Decaying leaves drop what breaking them drops — the odd stick — which
      // is what makes clearing a canopy worth doing rather than just tidy.
      this.items.spawnFromBlock(x, y, z, dropsFor(block, null));
      this.scheduleFall(x, y + 1, z);
    }
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

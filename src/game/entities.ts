/**
 * Dropped items lying in the world.
 *
 * The first entities the engine has ever had. Kept deliberately thin — a flat
 * array of structs, integrated in one pass, drawn in one instanced call — both
 * because that is all a dropped item needs and because whatever shape this
 * takes is the shape mobs will inherit.
 *
 * Collision reuses the player's idea of the world (`isSolidAt` per axis) rather
 * than anything new: an item is a small box falling through the same grid.
 */

import type { World } from '../world/world.ts';
import { WORLD_HEIGHT } from '../world/constants.ts';
import type { Inventory } from './inventory.ts';
import { maxStack, sameItem, type ItemStack } from './items.ts';

/** Half-width of the item's collision box. */
const HALF = 0.13;
const HEIGHT = 0.26;

const GRAVITY = 22.0;
const TERMINAL = 30.0;
const GROUND_FRICTION = 7.0;
const AIR_FRICTION = 0.35;
const WATER_DRAG = 4.5;
/** Upward push in a fluid: a dropped item bobs up rather than sinking away. */
const BUOYANCY = 14.0;

/** How close the player has to be before an item starts drifting toward them. */
const ATTRACT_RANGE = 2.0;
const ATTRACT_FORCE = 11.0;

/**
 * The pickup volume, as the player's box grown by a block — not a sphere.
 *
 * A sphere around the chest was the first attempt and it had a hole in it: an
 * item lying at the player's feet sits about a metre below the centre, so
 * standing directly on top of a dropped block did nothing at all. The reference
 * grows the player's bounding box instead, which is why walking over something
 * always works there.
 */
const PICKUP_REACH_XZ = 1.0;
const PICKUP_BELOW = 0.7;
const PICKUP_ABOVE = 2.2;

/** Items on the ground merge when they are this close and are the same thing. */
const MERGE_RANGE = 0.7;

/** Seconds an item survives before it is gone for good. */
const LIFETIME = 300;

/**
 * Upper bound on how many items may exist.
 *
 * A cap rather than an assumption: mining a wall of gravel with a shovel drops
 * a hundred items in ten seconds, and the merge pass is quadratic.
 */
const MAX_ENTITIES = 256;

export interface ItemEntity {
  item: ItemStack;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds since it appeared; drives bob, spin and despawn. */
  age: number;
  /** Seconds before the player may pick it up. Stops a throw from bouncing back. */
  pickupDelay: number;
  onGround: boolean;
}

export class ItemEntities {
  readonly list: ItemEntity[] = [];

  /** Seconds until the next merge sweep; see `MAX_ENTITIES`. */
  private mergeTimer = 0;

  get count(): number { return this.list.length; }

  clear(): void { this.list.length = 0; }

  spawn(
    x: number, y: number, z: number, item: ItemStack,
    vx = 0, vy = 0, vz = 0, pickupDelay = 0.5,
  ): ItemEntity | null {
    if (this.list.length >= MAX_ENTITIES) return null;
    const entity: ItemEntity = {
      item, x, y, z, vx, vy, vz, age: 0, pickupDelay, onGround: false,
    };
    this.list.push(entity);
    return entity;
  }

  /**
   * Scatters what a broken block left behind.
   *
   * The little random push is not decoration: without it every drop lands on
   * the exact centre of the block that used to be there, and a wall of them
   * reads as a grid of floating cubes rather than as debris.
   */
  spawnFromBlock(x: number, y: number, z: number, drops: readonly ItemStack[]): void {
    for (const item of drops) {
      this.spawn(
        x + 0.5, y + 0.25, z + 0.5, item,
        (Math.random() - 0.5) * 1.6, 2.0 + Math.random() * 0.6, (Math.random() - 0.5) * 1.6,
      );
    }
  }

  /** Throws a stack out of the player's hand. */
  throwFrom(
    position: Float32Array, forward: Float32Array, item: ItemStack,
  ): void {
    this.spawn(
      position[0], position[1], position[2], item,
      forward[0] * 5.5, forward[1] * 5.5 + 1.4, forward[2] * 5.5,
      // Long enough that walking forward while dropping does not re-collect it.
      1.2,
    );
  }

  /**
   * Integrates every item, then collects the ones the player reached.
   *
   * Returns how many items went into the inventory, which the caller turns into
   * a sound.
   */
  update(
    dt: number, world: World, inventory: Inventory,
    playerX: number, playerY: number, playerZ: number,
  ): number {
    let collected = 0;
    const targetY = playerY + 0.9;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.age += dt;
      if (e.pickupDelay > 0) e.pickupDelay -= dt;

      if (e.age > LIFETIME) {
        this.list.splice(i, 1);
        continue;
      }

      const inFluid = world.isFluidAt(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z));

      // Attraction, then physics: an item being drawn in should not also be
      // fighting friction on the ground.
      const dx = playerX - e.x;
      const dy = targetY - e.y;
      const dz = playerZ - e.z;
      const distance = Math.hypot(dx, dy, dz);

      if (e.pickupDelay <= 0 && distance < ATTRACT_RANGE) {
        const pull = (1 - distance / ATTRACT_RANGE) * ATTRACT_FORCE * dt;
        const inv = 1 / Math.max(distance, 1e-3);
        e.vx += dx * inv * pull;
        e.vy += dy * inv * pull;
        e.vz += dz * inv * pull;
      }

      const withinBox =
        Math.abs(playerX - e.x) < PICKUP_REACH_XZ &&
        Math.abs(playerZ - e.z) < PICKUP_REACH_XZ &&
        e.y > playerY - PICKUP_BELOW && e.y < playerY + PICKUP_ABOVE;

      if (e.pickupDelay <= 0 && withinBox) {
        const left = inventory.add(e.item);
        if (left <= 0) {
          collected += e.item.count;
          this.list.splice(i, 1);
          continue;
        }
        if (left < e.item.count) {
          collected += e.item.count - left;
          e.item.count = left;
        }
        // A full inventory leaves it lying there, which is the correct answer:
        // silently deleting what does not fit is how a player loses diamonds.
      }

      if (inFluid) {
        e.vy += (BUOYANCY - GRAVITY) * dt;
        const drag = Math.exp(-WATER_DRAG * dt);
        e.vx *= drag; e.vy *= drag; e.vz *= drag;
      } else {
        e.vy -= GRAVITY * dt;
        if (e.vy < -TERMINAL) e.vy = -TERMINAL;
      }

      const friction = e.onGround ? GROUND_FRICTION : AIR_FRICTION;
      const damping = Math.exp(-friction * dt);
      e.vx *= damping;
      e.vz *= damping;

      e.onGround = false;
      this.moveAxis(e, world, 1, e.vy * dt);
      this.moveAxis(e, world, 0, e.vx * dt);
      this.moveAxis(e, world, 2, e.vz * dt);
    }

    this.mergeTimer -= dt;
    if (this.mergeTimer <= 0) {
      this.mergeTimer = 0.5;
      this.merge();
    }

    return collected;
  }

  /** One axis of motion with a push-out, exactly as the player resolves it. */
  private moveAxis(e: ItemEntity, world: World, axis: number, amount: number): void {
    if (amount === 0) return;

    if (axis === 0) e.x += amount;
    else if (axis === 1) e.y += amount;
    else e.z += amount;

    const x0 = Math.floor(e.x - HALF), x1 = Math.floor(e.x + HALF);
    const y0 = Math.floor(e.y), y1 = Math.floor(e.y + HEIGHT);
    const z0 = Math.floor(e.z - HALF), z1 = Math.floor(e.z + HALF);

    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= WORLD_HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (!world.isSolidAt(x, y, z)) continue;
          if (axis === 0) {
            e.x = amount > 0 ? x - HALF - 1e-4 : x + 1 + HALF + 1e-4;
            e.vx = 0;
          } else if (axis === 1) {
            if (amount > 0) {
              e.y = y - HEIGHT - 1e-4;
            } else {
              e.y = y + 1 + 1e-4;
              e.onGround = true;
            }
            e.vy = 0;
          } else {
            e.z = amount > 0 ? z - HALF - 1e-4 : z + 1 + HALF + 1e-4;
            e.vz = 0;
          }
          return;
        }
      }
    }
  }

  /**
   * Folds neighbouring identical stacks into one.
   *
   * Without it, clearing a tree leaves forty separate one-log entities in a
   * pile — forty physics bodies, forty draws' worth of instance data, and forty
   * pickups the player hears one after another.
   */
  private merge(): void {
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      const limit = maxStack(a.item.id);
      if (a.item.count >= limit) continue;
      for (let j = this.list.length - 1; j > i; j--) {
        const b = this.list[j];
        if (!sameItem(a.item, b.item)) continue;
        if (Math.abs(a.x - b.x) > MERGE_RANGE ||
            Math.abs(a.y - b.y) > MERGE_RANGE ||
            Math.abs(a.z - b.z) > MERGE_RANGE) continue;
        const moved = Math.min(limit - a.item.count, b.item.count);
        if (moved <= 0) continue;
        a.item.count += moved;
        b.item.count -= moved;
        // The younger stack inherits the older one's age, so a pile that keeps
        // being topped up does not live for ever.
        a.age = Math.max(a.age, b.age);
        if (b.item.count <= 0) this.list.splice(j, 1);
        if (a.item.count >= limit) break;
      }
    }
  }
}

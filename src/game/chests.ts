/**
 * Chests.
 *
 * The second block with state, and deliberately the simplest possible one: a
 * chest is twenty-seven slots and nothing else — no timers, no logic, no tick.
 * It exists to answer the question the inventory raised the moment it worked:
 * thirty-six slots fill up in one mining trip, and without somewhere to put the
 * cobblestone the only way to make room is to throw it on the ground.
 *
 * Storage follows the furnace: state in a map keyed by position, the world
 * knowing only "there is a chest here". The two are not merged into one
 * `BlockEntity` abstraction because they share exactly one thing — a key — and
 * an abstraction over two cases with one thing in common is a worse thing to
 * read than two hundred-line files.
 */

import type { Inventory, Slot } from './inventory.ts';
import { maxStack, sameItem, stack, type ItemStack } from './items.ts';

/** Three rows of nine, as in the reference. */
export const CHEST_SIZE = 27;

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

export class Chests {
  private readonly map = new Map<string, Slot[]>();
  private readonly places = new Map<string, [number, number, number]>();

  get count(): number { return this.map.size; }

  /** The chest at these coordinates, created empty if it is new. */
  at(x: number, y: number, z: number): Slot[] {
    const k = key(x, y, z);
    let slots = this.map.get(k);
    if (!slots) {
      slots = new Array<Slot>(CHEST_SIZE).fill(null);
      this.map.set(k, slots);
      this.places.set(k, [x, y, z]);
    }
    return slots;
  }

  peek(x: number, y: number, z: number): Slot[] | null {
    return this.map.get(key(x, y, z)) ?? null;
  }

  /** Forgets a chest and hands back what was in it, for the caller to drop. */
  remove(x: number, y: number, z: number): ItemStack[] {
    const k = key(x, y, z);
    const slots = this.map.get(k);
    if (!slots) return [];
    this.map.delete(k);
    this.places.delete(k);
    return slots.filter((s): s is ItemStack => !!s);
  }

  clear(): void {
    this.map.clear();
    this.places.clear();
  }

  /**
   * Shift-click from a chest slot into the bag, or the other way.
   *
   * Lives here rather than in the window because it is the one chest operation
   * with a rule — fill partial stacks first, then empty slots — and that rule
   * is the same one `Inventory.add` follows. Returns true if anything moved.
   */
  static quickMoveInto(slots: Slot[], item: ItemStack): number {
    let remaining = item.count;
    const limit = maxStack(item.id);

    if (limit > 1) {
      for (let i = 0; i < slots.length && remaining > 0; i++) {
        const slot = slots[i];
        if (!slot || !sameItem(slot, item) || slot.count >= limit) continue;
        const moved = Math.min(limit - slot.count, remaining);
        slot.count += moved;
        remaining -= moved;
      }
    }
    for (let i = 0; i < slots.length && remaining > 0; i++) {
      if (slots[i]) continue;
      const moved = Math.min(limit, remaining);
      slots[i] = stack(item.id, moved, item.damage);
      remaining -= moved;
    }
    return remaining;
  }

  /** Empties a chest into an inventory as far as it will go. */
  static dumpInto(slots: Slot[], inventory: Inventory): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      const left = inventory.add(slot);
      slots[i] = left > 0 ? stack(slot.id, left, slot.damage) : null;
    }
  }

  // --- persistence ---------------------------------------------------------

  /**
   * Position, then a run of `[slot, item, count, damage]` quads, then a
   * terminator. Chests are sparse — a full one is 27 quads, an empty one is
   * three numbers — so the length is not fixed and the record says where it
   * ends.
   */
  serialize(): number[] {
    const out: number[] = [];
    for (const [k, slots] of this.map) {
      const place = this.places.get(k);
      if (!place) continue;
      out.push(place[0], place[1], place[2]);
      let filled = 0;
      const start = out.length;
      out.push(0);
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (!slot) continue;
        out.push(i, slot.id, slot.count, slot.damage);
        filled++;
      }
      out[start] = filled;
    }
    return out;
  }

  load(data: readonly number[] | undefined): void {
    this.clear();
    if (!data) return;
    let i = 0;
    while (i + 4 <= data.length) {
      const x = data[i], y = data[i + 1], z = data[i + 2];
      const filled = data[i + 3];
      i += 4;
      const slots = this.at(x, y, z);
      for (let n = 0; n < filled && i + 4 <= data.length; n++, i += 4) {
        const index = data[i];
        if (index < 0 || index >= CHEST_SIZE) continue;
        if (data[i + 1] === 0 || data[i + 2] <= 0) continue;
        slots[index] = stack(data[i + 1], data[i + 2], data[i + 3]);
      }
    }
  }
}

/** Total items in a chest, for the debug API and the tests. */
export function chestCount(slots: Slot[]): number {
  let total = 0;
  for (const slot of slots) if (slot) total += slot.count;
  return total;
}

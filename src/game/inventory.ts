/**
 * The bag.
 *
 * Pure functions over an array of slots: no DOM, no world, no rendering. That
 * is not tidiness for its own sake — this is the thing that has to be
 * serialised into the save file and, one day, reconciled across a network, and
 * both of those are only possible if it is data.
 *
 * Layout matches the reference so muscle memory transfers: slots 0..8 are the
 * hotbar row, 9..35 the three storage rows above it.
 */

import {
  NO_ITEM, itemDef, maxStack, sameItem, stack, type ItemId, type ItemStack,
} from './items.ts';

export const HOTBAR_SIZE = 9;
export const STORAGE_SIZE = 27;
export const INVENTORY_SIZE = HOTBAR_SIZE + STORAGE_SIZE;

/** A stack the UI is dragging, or a crafting grid cell. */
export type Slot = ItemStack | null;

export class Inventory {
  readonly slots: Slot[] = new Array(INVENTORY_SIZE).fill(null);

  /** The stack on the cursor while the inventory window is open. */
  cursor: Slot = null;

  /** Which hotbar slot the hand is on. */
  selected = 0;

  /**
   * Bumped by every mutation.
   *
   * The window redraws 36 slots, and doing that every frame for a panel that
   * changes twice a minute is the kind of cost that shows up as a stutter while
   * mining. One integer comparison answers "is a redraw needed".
   */
  version = 0;

  private touch(): void { this.version++; }

  get held(): Slot {
    return this.slots[this.selected];
  }

  get(index: number): Slot {
    return this.slots[index] ?? null;
  }

  set(index: number, value: Slot): void {
    this.slots[index] = value && value.count > 0 ? value : null;
    this.touch();
  }

  /**
   * Adds a stack, filling partial stacks of the same item first.
   *
   * Returns how many items did not fit — the caller has to decide whether that
   * means "keep it on the ground" (a pickup) or "spill it back out" (a craft).
   */
  add(item: ItemStack): number {
    let remaining = item.count;
    const limit = maxStack(item.id);

    // Top up matching stacks. Hotbar first: a player watching the bottom of the
    // screen should see the number they are carrying go up.
    if (limit > 1) {
      for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
        const slot = this.slots[i];
        if (!slot || !sameItem(slot, item) || slot.count >= limit) continue;
        const room = limit - slot.count;
        const moved = Math.min(room, remaining);
        slot.count += moved;
        remaining -= moved;
      }
    }

    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(limit, remaining);
      this.slots[i] = stack(item.id, moved, item.damage);
      remaining -= moved;
    }

    if (remaining !== item.count) this.touch();
    return remaining;
  }

  /** Convenience for drops and the `give` command. */
  addItem(id: ItemId, count = 1, damage = 0): number {
    return this.add(stack(id, count, damage));
  }

  /** True when every one of `item` would fit. Does not mutate. */
  canFit(item: ItemStack): boolean {
    const limit = maxStack(item.id);
    let room = 0;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = this.slots[i];
      if (!slot) room += limit;
      else if (sameItem(slot, item) && slot.count < limit) room += limit - slot.count;
      if (room >= item.count) return true;
    }
    return false;
  }

  /** Takes up to `count` from one slot. */
  take(index: number, count = 1): Slot {
    const slot = this.slots[index];
    if (!slot) return null;
    const moved = Math.min(count, slot.count);
    const taken = stack(slot.id, moved, slot.damage);
    slot.count -= moved;
    if (slot.count <= 0) this.slots[index] = null;
    this.touch();
    return taken;
  }

  /** How many of an item are carried, across every slot. */
  count(id: ItemId): number {
    let total = 0;
    for (const slot of this.slots) if (slot && slot.id === id) total += slot.count;
    return total;
  }

  /** Removes `count` of an item wherever it is found. Returns what was removed. */
  removeItem(id: ItemId, count: number): number {
    let left = count;
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.id !== id) continue;
      const moved = Math.min(slot.count, left);
      slot.count -= moved;
      left -= moved;
      if (slot.count <= 0) this.slots[i] = null;
    }
    if (left !== count) this.touch();
    return count - left;
  }

  /** Spends one of the held stack — what placing a block costs. */
  consumeHeld(count = 1): void {
    const slot = this.held;
    if (!slot) return;
    slot.count -= count;
    if (slot.count <= 0) this.slots[this.selected] = null;
    this.touch();
  }

  /**
   * Wears the held tool by one use. Returns true if it broke.
   *
   * Only tools have durability, so this is a no-op for a handful of dirt, which
   * is what lets the caller call it unconditionally after every swing.
   */
  damageHeld(amount = 1): boolean {
    const slot = this.held;
    if (!slot) return false;
    const limit = itemDef(slot.id).durability;
    if (limit <= 0) return false;
    slot.damage += amount;
    this.touch();
    if (slot.damage >= limit) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  // --- window interactions -------------------------------------------------

  /**
   * Left-click on a slot: swap with the cursor, or merge into it.
   *
   * The merge case is the one that matters: clicking a stack of 30 cobblestone
   * while holding 40 must leave 64 in the slot and 6 on the cursor, not swap.
   */
  clickSlot(index: number): void {
    const slot = this.slots[index];
    const cursor = this.cursor;

    if (cursor && slot && sameItem(cursor, slot)) {
      const limit = maxStack(slot.id);
      const moved = Math.min(limit - slot.count, cursor.count);
      slot.count += moved;
      cursor.count -= moved;
      this.cursor = cursor.count > 0 ? cursor : null;
      this.touch();
      return;
    }

    this.slots[index] = cursor;
    this.cursor = slot;
    this.touch();
  }

  /** Right-click: pick up half, or put down one. */
  rightClickSlot(index: number): void {
    const slot = this.slots[index];
    const cursor = this.cursor;

    if (!cursor) {
      if (!slot) return;
      const half = Math.ceil(slot.count / 2);
      this.cursor = this.take(index, half);
      return;
    }

    if (!slot) {
      this.slots[index] = stack(cursor.id, 1, cursor.damage);
      cursor.count--;
    } else if (sameItem(slot, cursor) && slot.count < maxStack(slot.id)) {
      slot.count++;
      cursor.count--;
    } else {
      this.clickSlot(index);
      return;
    }

    if (cursor.count <= 0) this.cursor = null;
    this.touch();
  }

  /**
   * Shift-click: send a stack across the divide between hotbar and storage.
   *
   * One gesture, and it is the one a player uses more than any other once they
   * have more than a pocketful.
   */
  quickMove(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    const toStorage = index < HOTBAR_SIZE;
    const from = toStorage ? HOTBAR_SIZE : 0;
    const to = toStorage ? INVENTORY_SIZE : HOTBAR_SIZE;

    const limit = maxStack(slot.id);
    if (limit > 1) {
      for (let i = from; i < to && slot.count > 0; i++) {
        const other = this.slots[i];
        if (!other || !sameItem(other, slot) || other.count >= limit) continue;
        const moved = Math.min(limit - other.count, slot.count);
        other.count += moved;
        slot.count -= moved;
      }
    }
    for (let i = from; i < to && slot.count > 0; i++) {
      if (this.slots[i]) continue;
      this.slots[i] = stack(slot.id, slot.count, slot.damage);
      slot.count = 0;
    }

    if (slot.count <= 0) this.slots[index] = null;
    this.touch();
  }

  // --- persistence ---------------------------------------------------------

  /** Compact enough to sit in the save record: `[id, count, damage]` triples. */
  serialize(): number[] {
    const out: number[] = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      out.push(i, slot.id, slot.count, slot.damage);
    }
    return out;
  }

  load(data: readonly number[] | undefined): void {
    this.slots.fill(null);
    if (data) {
      for (let i = 0; i + 3 < data.length; i += 4) {
        const index = data[i];
        if (index < 0 || index >= INVENTORY_SIZE) continue;
        if (data[i + 1] === NO_ITEM || data[i + 2] <= 0) continue;
        this.slots[index] = stack(data[i + 1], data[i + 2], data[i + 3]);
      }
    }
    this.touch();
  }

  clear(): void {
    this.slots.fill(null);
    this.cursor = null;
    this.touch();
  }
}

/**
 * A crafting grid, 2×2 in the inventory window and 3×3 on a table.
 *
 * Kept separate from the inventory because its contents are not carried: what
 * is in the grid when the window closes falls back into the bag, and code that
 * cannot tell the two apart is how items get duplicated.
 */
export class CraftGrid {
  cells: Slot[];

  constructor(public size: number) {
    this.cells = new Array(size * size).fill(null);
  }

  resize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    this.cells = new Array(size * size).fill(null);
  }

  get(index: number): Slot { return this.cells[index] ?? null; }
  set(index: number, value: Slot): void {
    this.cells[index] = value && value.count > 0 ? value : null;
  }

  /** Spends one item from every filled cell — one craft. */
  consumeOne(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (!cell) continue;
      cell.count--;
      if (cell.count <= 0) this.cells[i] = null;
    }
  }

  /** Empties the grid into an inventory. Anything that does not fit is returned. */
  returnTo(inventory: Inventory): ItemStack[] {
    const spilled: ItemStack[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (!cell) continue;
      this.cells[i] = null;
      const left = inventory.add(cell);
      if (left > 0) spilled.push(stack(cell.id, left, cell.damage));
    }
    return spilled;
  }
}

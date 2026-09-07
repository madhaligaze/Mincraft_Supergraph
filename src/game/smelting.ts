/**
 * Furnaces.
 *
 * The first block in the world with **state**. Everything up to now was a
 * single id in a byte array; a furnace has to remember three item stacks and
 * two timers, and none of that fits in a block id.
 *
 * So the state lives here, in a map keyed by position, and the world keeps only
 * "there is a furnace at these coordinates". That split is the same one chests
 * will need, which is why it is a general `key -> record` map and not three
 * fields bolted onto the block registry.
 *
 * Why it matters for the game rather than for the architecture: without
 * smelting the tool chain dead-ends at stone. Iron ore gives raw iron, raw iron
 * is not a pickaxe, and diamonds — which only an iron pickaxe can harvest —
 * stay unreachable for ever. A furnace is the block that turns a cave full of
 * ore into a reason to go down there.
 */

import { Block } from '../world/blocks.ts';
import {
  Item, itemForBlock, maxStack, sameItem, stack, type ItemId, type ItemStack,
} from './items.ts';
import type { Slot } from './inventory.ts';

/** Seconds one item takes to smelt. The reference's ten. */
export const SMELT_SECONDS = 10;

/** input item -> what comes out. */
const SMELT: Map<ItemId, ItemStack> = new Map([
  [Item.RawIron, stack(Item.IronIngot, 1)],
  [Item.RawGold, stack(Item.GoldIngot, 1)],
  [itemForBlock(Block.Sand), stack(itemForBlock(Block.Glass), 1)],
  [itemForBlock(Block.RedSand), stack(itemForBlock(Block.Glass), 1)],
  [itemForBlock(Block.Cobblestone), stack(itemForBlock(Block.Stone), 1)],
  [itemForBlock(Block.Clay), stack(itemForBlock(Block.Sandstone), 1)],
  [itemForBlock(Block.OakLog), stack(Item.Charcoal, 1)],
  [itemForBlock(Block.BirchLog), stack(Item.Charcoal, 1)],
  [itemForBlock(Block.SpruceLog), stack(Item.Charcoal, 1)],
]);

/** fuel item -> seconds of burn. The reference's numbers. */
const FUEL: Map<ItemId, number> = new Map([
  [Item.Coal, 80],
  [Item.Charcoal, 80],
  [Item.Stick, 5],
  [itemForBlock(Block.OakPlanks), 15],
  [itemForBlock(Block.OakLog), 15],
  [itemForBlock(Block.BirchLog), 15],
  [itemForBlock(Block.SpruceLog), 15],
  [itemForBlock(Block.CraftingTable), 15],
]);

export const smeltResult = (id: ItemId): ItemStack | null => {
  const out = SMELT.get(id);
  return out ? { ...out } : null;
};

export const fuelSeconds = (id: ItemId): number => FUEL.get(id) ?? 0;

/** One furnace's contents and timers. */
export interface FurnaceState {
  input: Slot;
  fuel: Slot;
  output: Slot;
  /** Seconds of burn left in the fuel already consumed. */
  burn: number;
  /** What that fuel was worth in full, for the flame gauge. */
  burnTotal: number;
  /** Seconds of progress on the current item. */
  cook: number;
}

const emptyFurnace = (): FurnaceState => ({
  input: null, fuel: null, output: null, burn: 0, burnTotal: 0, cook: 0,
});

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * What a furnace needs from the world: swap the block for its lit twin.
 *
 * A callback rather than a `World` import so this module stays testable and
 * knows nothing about chunk streaming.
 */
export type BlockSwap = (x: number, y: number, z: number, block: Block) => void;

export class Furnaces {
  private readonly map = new Map<string, FurnaceState>();
  /** Coordinates per key, so the tick can talk back to the world. */
  private readonly places = new Map<string, [number, number, number]>();

  get count(): number { return this.map.size; }

  /** The furnace at these coordinates, created empty if it is new. */
  at(x: number, y: number, z: number): FurnaceState {
    const k = key(x, y, z);
    let state = this.map.get(k);
    if (!state) {
      state = emptyFurnace();
      this.map.set(k, state);
      this.places.set(k, [x, y, z]);
    }
    return state;
  }

  /** Existing state, without creating one. */
  peek(x: number, y: number, z: number): FurnaceState | null {
    return this.map.get(key(x, y, z)) ?? null;
  }

  /**
   * Forgets a furnace and hands back what was inside, for the caller to drop.
   */
  remove(x: number, y: number, z: number): ItemStack[] {
    const k = key(x, y, z);
    const state = this.map.get(k);
    if (!state) return [];
    this.map.delete(k);
    this.places.delete(k);
    return [state.input, state.fuel, state.output].filter((s): s is ItemStack => !!s);
  }

  clear(): void {
    this.map.clear();
    this.places.clear();
  }

  /**
   * Advances every furnace.
   *
   * Runs over all of them each frame: a world has a handful, and the
   * alternative — waking only the ones near the player — would stop a furnace
   * the moment its owner walked away, which is not what a furnace does.
   */
  update(dt: number, swap: BlockSwap): void {
    for (const [k, state] of this.map) {
      const result = state.input ? smeltResult(state.input.id) : null;
      const canCook = !!result && this.outputHasRoom(state, result);

      if (state.burn > 0) state.burn = Math.max(0, state.burn - dt);

      // Light a new piece of fuel only when there is something to cook.
      if (state.burn <= 0 && canCook && state.fuel) {
        const seconds = fuelSeconds(state.fuel.id);
        if (seconds > 0) {
          state.burn = seconds;
          state.burnTotal = seconds;
          state.fuel.count--;
          if (state.fuel.count <= 0) state.fuel = null;
        }
      }

      if (state.burn > 0 && canCook && result) {
        state.cook += dt;
        if (state.cook >= SMELT_SECONDS) {
          state.cook -= SMELT_SECONDS;
          this.produce(state, result);
          state.input!.count--;
          if (state.input!.count <= 0) state.input = null;
        }
      } else {
        // Progress decays rather than being thrown away, so a furnace that runs
        // out of fuel for a moment does not restart from zero.
        state.cook = Math.max(0, state.cook - dt * 2);
      }

      // The block is told what it *is*, not what changed.
      //
      // Watching for the transition looks cheaper and is subtly wrong: anything
      // that sets the timer from outside this loop — loading a save, a test, a
      // future hopper — leaves the block stuck showing the opposite state, with
      // no transition left to notice. The callback ignores a swap that is
      // already in place, so this costs one block read per furnace per tick.
      const place = this.places.get(k);
      if (place) {
        swap(place[0], place[1], place[2],
          state.burn > 0 ? Block.FurnaceLit : Block.Furnace);
      }
    }
  }

  private outputHasRoom(state: FurnaceState, result: ItemStack): boolean {
    if (!state.output) return true;
    if (!sameItem(state.output, result)) return false;
    return state.output.count + result.count <= maxStack(result.id);
  }

  private produce(state: FurnaceState, result: ItemStack): void {
    if (!state.output) state.output = stack(result.id, result.count);
    else state.output.count += result.count;
  }

  // --- persistence ---------------------------------------------------------

  /**
   * Flat numbers, the way the inventory serialises: position, three stacks,
   * two timers. Twelve per furnace, and a world has a handful of them.
   */
  serialize(): number[] {
    const out: number[] = [];
    for (const [k, state] of this.map) {
      const place = this.places.get(k);
      if (!place) continue;
      out.push(place[0], place[1], place[2]);
      for (const slot of [state.input, state.fuel, state.output]) {
        out.push(slot ? slot.id : 0, slot ? slot.count : 0);
      }
      out.push(state.burn, state.burnTotal, state.cook);
    }
    return out;
  }

  load(data: readonly number[] | undefined): void {
    this.clear();
    if (!data) return;
    const STRIDE = 12;
    for (let i = 0; i + STRIDE <= data.length; i += STRIDE) {
      const state = this.at(data[i], data[i + 1], data[i + 2]);
      const read = (at: number): Slot =>
        data[at] > 0 && data[at + 1] > 0 ? stack(data[at], data[at + 1]) : null;
      state.input = read(i + 3);
      state.fuel = read(i + 5);
      state.output = read(i + 7);
      state.burn = data[i + 9];
      state.burnTotal = data[i + 10];
      state.cook = data[i + 11];
    }
  }
}

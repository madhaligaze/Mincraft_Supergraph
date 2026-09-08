/**
 * What a broken block leaves behind.
 *
 * Data, not code: the interesting part of a drop table is that it is a table.
 * The default — a block drops itself, and drops nothing when the harvest
 * requirement is not met — covers most of the registry, so only the exceptions
 * are listed, and every exception is one the player would notice: grass giving
 * dirt, stone giving cobblestone, coal ore giving coal.
 */

import { Block } from '../world/blocks.ts';
import { Item, itemForBlock, stack, type ItemId, type ItemStack } from './items.ts';
import { canHarvest } from './mining.ts';

interface Drop {
  item: ItemId;
  min: number;
  max: number;
  /** 0..1; rolled once per drop entry. */
  chance: number;
}

const drop = (item: ItemId, min = 1, max = min, chance = 1): Drop => ({ item, min, max, chance });

const TABLE: Array<Drop[] | undefined> = [];

const set = (block: Block, drops: Drop[]): void => { TABLE[block] = drops; };

set(Block.GrassBlock, [drop(itemForBlock(Block.Dirt))]);
set(Block.Podzol, [drop(itemForBlock(Block.Dirt))]);
set(Block.Stone, [drop(itemForBlock(Block.Cobblestone))]);

set(Block.CoalOre, [drop(Item.Coal)]);
set(Block.IronOre, [drop(Item.RawIron)]);
set(Block.GoldOre, [drop(Item.RawGold)]);
set(Block.DiamondOre, [drop(Item.Diamond)]);

// Leaves give the odd stick, which is what makes a treeless start survivable.
const LEAF_DROPS = [drop(Item.Stick, 1, 2, 0.06)];
// Oak also drops apples — the only food in the world, so the rate is the
// reference's raised from half a percent to five: with no farms and no animals
// a player who never finds one starves, and that is a worse game than a
// generous apple tree.
set(Block.OakLeaves, [...LEAF_DROPS, drop(Item.Apple, 1, 1, 0.05)]);
set(Block.BirchLeaves, LEAF_DROPS);
set(Block.SpruceLeaves, LEAF_DROPS);

// A burning furnace picked up is still just a furnace.
set(Block.FurnaceLit, [drop(itemForBlock(Block.Furnace))]);

// Nothing comes back without a silk touch that does not exist yet.
set(Block.Glass, []);
set(Block.Ice, []);

/**
 * Rolls the table for one broken block.
 *
 * `held` decides both whether anything drops at all (the harvest check) and,
 * later, how much — fortune and silk touch would hook in here.
 */
export function dropsFor(block: Block, held: ItemStack | null): ItemStack[] {
  if (block === Block.Air) return [];
  if (!canHarvest(block, held)) return [];

  const table = TABLE[block];
  if (!table) return [stack(itemForBlock(block), 1)];

  const out: ItemStack[] = [];
  for (const entry of table) {
    if (entry.chance < 1 && Math.random() >= entry.chance) continue;
    const count = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
    if (count > 0) out.push(stack(entry.item, count));
  }
  return out;
}

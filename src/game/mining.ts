/**
 * How long a block takes to break, and whether it gives anything up.
 *
 * `BLOCK_HARDNESS` has been in the registry since the first week and nothing
 * read it: one click removed any block. That is the single loudest difference
 * from the reference — mining is the verb the game is built around, and without
 * a duration it has no texture, no progression and no reason to want a better
 * pickaxe.
 *
 * The timing formula is Minecraft's:
 *
 *     seconds = hardness * (harvestable ? 1.5 : 5) / toolSpeed
 *
 * which puts stone by hand at 7.5 s and stone with an iron pickaxe at 0.375 s —
 * the two numbers a player's hands already know.
 */

import { Block, BLOCK_HARDNESS } from '../world/blocks.ts';
import {
  ToolKind, Tier, TIER_SPEED, itemDef, type ItemStack,
} from './items.ts';

/** Which tool is the right tool for each block. */
export const BLOCK_TOOL = new Uint8Array(Block.Count);

/**
 * Lowest tier that gets a drop, per block. Zero means bare hands are enough.
 *
 * Above zero it also implies the *kind* has to match: an iron shovel is tier 3
 * and still gets nothing out of stone.
 */
export const BLOCK_HARVEST = new Uint8Array(Block.Count);

const PICKAXE: ReadonlyArray<[Block, Tier]> = [
  [Block.Stone, Tier.Wood], [Block.Granite, Tier.Wood], [Block.Andesite, Tier.Wood],
  [Block.Cobblestone, Tier.Wood], [Block.MossyCobblestone, Tier.Wood],
  [Block.Sandstone, Tier.Wood], [Block.Glowstone, Tier.Hand],
  [Block.Ice, Tier.Wood], [Block.PackedIce, Tier.Wood],
  [Block.CoalOre, Tier.Wood],
  [Block.IronOre, Tier.Stone], [Block.GoldOre, Tier.Iron], [Block.DiamondOre, Tier.Iron],
];

const SHOVEL: readonly Block[] = [
  Block.Dirt, Block.GrassBlock, Block.Podzol, Block.Sand, Block.RedSand,
  Block.Gravel, Block.Clay, Block.SnowBlock,
];

const AXE: readonly Block[] = [
  Block.OakLog, Block.BirchLog, Block.SpruceLog, Block.OakPlanks, Block.CraftingTable,
];

for (const [block, tier] of PICKAXE) {
  BLOCK_TOOL[block] = ToolKind.Pickaxe;
  BLOCK_HARVEST[block] = tier;
}
for (const block of SHOVEL) BLOCK_TOOL[block] = ToolKind.Shovel;
for (const block of AXE) BLOCK_TOOL[block] = ToolKind.Axe;

/** Blocks nothing can break. Fluids and bedrock carry an absurd hardness. */
export const isUnbreakable = (block: Block): boolean => BLOCK_HARDNESS[block] >= 1e6;

/** Does this held item satisfy the block's harvest requirement? */
export function canHarvest(block: Block, held: ItemStack | null): boolean {
  const required = BLOCK_HARVEST[block];
  if (required === Tier.Hand) return true;
  if (!held) return false;
  const def = itemDef(held.id);
  return def.tool === BLOCK_TOOL[block] && def.tier >= required;
}

/** How fast the held item works on this block, as a multiple of a bare hand. */
export function toolSpeed(block: Block, held: ItemStack | null): number {
  if (!held) return 1;
  const def = itemDef(held.id);
  if (def.tool === ToolKind.None || def.tool !== BLOCK_TOOL[block]) return 1;
  return TIER_SPEED[def.tier];
}

/** Seconds of continuous mining, or `Infinity` for something unbreakable. */
export function breakSeconds(block: Block, held: ItemStack | null): number {
  if (block === Block.Air) return Infinity;
  if (isUnbreakable(block)) return Infinity;
  const hardness = BLOCK_HARDNESS[block];
  if (hardness <= 0) return 0;
  return hardness * (canHarvest(block, held) ? 1.5 : 5) / toolSpeed(block, held);
}

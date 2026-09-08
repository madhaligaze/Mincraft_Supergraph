/**
 * Crafting recipes.
 *
 * Data, not code. A recipe is a picture of a grid and a result; matching is one
 * generic routine, and adding a recipe is adding three lines to a list.
 *
 * The set here is deliberately the smallest one that closes the loop: wood →
 * planks → sticks → table → pickaxe → stone → better pickaxe. Everything a
 * player does in their first ten minutes of the reference game is in that
 * chain, and nothing else is in it.
 */

import { Block } from '../world/blocks.ts';
import { Item, itemForBlock, stack, type ItemId, type ItemStack } from './items.ts';
import type { Slot } from './inventory.ts';

interface Recipe {
  /**
   * Rows of the pattern, top to bottom, one character per cell; a space is an
   * empty cell. Absent for a shapeless recipe.
   */
  pattern?: readonly string[];
  /** Character → item, for `pattern`. */
  key?: Record<string, ItemId>;
  /** Shapeless: these items in any arrangement, one cell each. */
  loose?: readonly ItemId[];
  result: ItemStack;
}

const PLANKS = itemForBlock(Block.OakPlanks);
const TABLE = itemForBlock(Block.CraftingTable);
const COBBLE = itemForBlock(Block.Cobblestone);

/** Any log gives planks; three near-identical recipes rather than a wildcard. */
const LOGS: readonly Block[] = [Block.OakLog, Block.BirchLog, Block.SpruceLog];

/** The four pieces, in the reference's shapes. */
function armourRecipes(
  material: ItemId,
  set: { helmet: ItemId; chestplate: ItemId; leggings: ItemId; boots: ItemId },
): Recipe[] {
  const key = { M: material };
  return [
    { pattern: ['MMM', 'M M'], key, result: stack(set.helmet, 1) },
    { pattern: ['M M', 'MMM', 'MMM'], key, result: stack(set.chestplate, 1) },
    { pattern: ['MMM', 'M M', 'M M'], key, result: stack(set.leggings, 1) },
    { pattern: ['M M', 'M M'], key, result: stack(set.boots, 1) },
  ];
}

/** `head` is the material a tool's business end is made of. */
function toolRecipes(
  head: ItemId, pickaxe: ItemId, shovel: ItemId, axe: ItemId,
): Recipe[] {
  const key = { H: head, S: Item.Stick };
  return [
    { pattern: ['HHH', ' S ', ' S '], key, result: stack(pickaxe, 1) },
    { pattern: ['H', 'S', 'S'], key, result: stack(shovel, 1) },
    { pattern: ['HH', 'HS', ' S'], key, result: stack(axe, 1) },
  ];
}

const RECIPES: Recipe[] = [
  ...LOGS.map((log): Recipe => ({ loose: [itemForBlock(log)], result: stack(PLANKS, 4) })),

  { pattern: ['P', 'P'], key: { P: PLANKS }, result: stack(Item.Stick, 4) },
  { pattern: ['PP', 'PP'], key: { P: PLANKS }, result: stack(TABLE, 1) },

  // Coal on a stick. The only light a player can make, and therefore the
  // difference between a mine and a hole they cannot see the bottom of.
  {
    pattern: ['C', 'S'], key: { C: Item.Coal, S: Item.Stick },
    result: stack(itemForBlock(Block.Torch), 4),
  },
  {
    pattern: ['C', 'S'], key: { C: Item.Charcoal, S: Item.Stick },
    result: stack(itemForBlock(Block.Torch), 4),
  },

  // Eight planks around an empty middle: the same shape as the furnace, which
  // is how the reference teaches the shape once and reuses it.
  {
    pattern: ['PPP', 'P P', 'PPP'], key: { P: PLANKS },
    result: stack(itemForBlock(Block.Chest), 1),
  },

  // Eight cobblestone around an empty middle. The furnace is what turns a cave
  // full of iron ore into iron tools, and iron tools into diamonds.
  {
    pattern: ['CCC', 'C C', 'CCC'], key: { C: COBBLE },
    result: stack(itemForBlock(Block.Furnace), 1),
  },

  ...toolRecipes(PLANKS, Item.WoodenPickaxe, Item.WoodenShovel, Item.WoodenAxe),
  ...toolRecipes(COBBLE, Item.StonePickaxe, Item.StoneShovel, Item.StoneAxe),
  ...toolRecipes(Item.IronIngot, Item.IronPickaxe, Item.IronShovel, Item.IronAxe),

  ...armourRecipes(Item.IronIngot, Item.Iron),
  ...armourRecipes(Item.Diamond, Item.Diamond_),

  // Back the other way, so a chest of cobblestone is not a dead end.
  { loose: [COBBLE, COBBLE, COBBLE, COBBLE], result: stack(itemForBlock(Block.Stone), 4) },
];

/** The filled sub-rectangle of a grid, or null when the grid is empty. */
function bounds(cells: readonly Slot[], size: number): {
  x0: number; y0: number; w: number; h: number;
} | null {
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!cells[y * size + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function matchesPattern(
  recipe: Recipe, cells: readonly Slot[], size: number, mirrored: boolean,
): boolean {
  const pattern = recipe.pattern!;
  const height = pattern.length;
  const width = Math.max(...pattern.map((row) => row.length));
  const box = bounds(cells, size);
  if (!box || box.w !== width || box.h !== height) return false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const column = mirrored ? width - 1 - x : x;
      const want = pattern[y][column] ?? ' ';
      const cell = cells[(box.y0 + y) * size + (box.x0 + x)];
      if (want === ' ') {
        if (cell) return false;
      } else {
        if (!cell || cell.id !== recipe.key![want]) return false;
      }
    }
  }
  return true;
}

function matchesLoose(recipe: Recipe, cells: readonly Slot[]): boolean {
  const wanted = [...recipe.loose!];
  const present: ItemId[] = [];
  for (const cell of cells) if (cell) present.push(cell.id);
  if (present.length !== wanted.length) return false;
  for (const id of present) {
    const at = wanted.indexOf(id);
    if (at < 0) return false;
    wanted.splice(at, 1);
  }
  return true;
}

/**
 * What the grid currently makes, or null.
 *
 * Shaped recipes match mirrored too, the way the reference does: a player who
 * lays an axe out left-handed gets an axe.
 */
export function matchRecipe(cells: readonly Slot[], size: number): ItemStack | null {
  for (const recipe of RECIPES) {
    if (recipe.loose) {
      if (matchesLoose(recipe, cells)) return { ...recipe.result };
      continue;
    }
    const pattern = recipe.pattern!;
    if (pattern.length > size) continue;
    if (Math.max(...pattern.map((row) => row.length)) > size) continue;
    if (matchesPattern(recipe, cells, size, false)) return { ...recipe.result };
    if (matchesPattern(recipe, cells, size, true)) return { ...recipe.result };
  }
  return null;
}

/** Every recipe, for the in-game reference list. */
export function recipeList(): ReadonlyArray<Recipe> {
  return RECIPES;
}

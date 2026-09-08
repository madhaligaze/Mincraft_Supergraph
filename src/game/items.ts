/**
 * Items.
 *
 * A block is a thing in the world; an item is a thing in a bag. The two are not
 * the same, and pretending they are is what makes a hotbar of nine block ids
 * feel like a debug menu rather than an inventory — there is nowhere to put a
 * stick, a lump of coal or a pickaxe.
 *
 * The id space is arranged so the common conversion is free: **every block id
 * is also the id of the item that places it**, and items that are not blocks
 * start above `Block.Count`. So `itemForBlock` is the identity function and
 * `blockOfItem` is a table lookup that returns `Block.Air` for a stick.
 */

import { Block, BLOCKS, BLOCK_ALBEDO } from '../world/blocks.ts';

export type ItemId = number;

/** An empty slot. Also `Block.Air`, which is the same statement twice. */
export const NO_ITEM = 0;

/** Which family of block a tool is meant for. */
export const enum ToolKind {
  None = 0,
  Pickaxe = 1,
  Shovel = 2,
  Axe = 3,
}

/**
 * Material tier, shared by the speed table and the harvest check.
 *
 * `Hand` is a tier so that "can bare hands harvest this" is the same question
 * as "is this tool good enough", asked with one comparison instead of two code
 * paths.
 */
export const enum Tier {
  Hand = 0,
  Wood = 1,
  Stone = 2,
  Iron = 3,
  Diamond = 4,
}

/** How many times faster than a bare hand each tier mines its own family. */
export const TIER_SPEED: readonly number[] = [1, 2, 4, 6, 8];

/** How many blocks a tool of each tier survives. */
const TIER_DURABILITY: readonly number[] = [0, 59, 131, 250, 1561];

/**
 * What the icon painter draws for this item.
 *
 * Deliberately a small closed set of shapes rather than one drawing per item:
 * a lump is a lump whether it is coal or a diamond, and the difference the
 * player reads at hotbar size is the colour.
 */
export type IconShape =
  'block' | 'lump' | 'ingot' | 'stick' | 'pickaxe' | 'shovel' | 'axe'
  | 'helmet' | 'chestplate' | 'leggings' | 'boots' | 'apple' | 'bucket';

/** Which body slot a piece of armour goes in, or `None` for everything else. */
export const enum ArmourSlot {
  None = -1,
  Head = 0,
  Chest = 1,
  Legs = 2,
  Feet = 3,
}

/** How many armour slots there are; the inventory keeps an array this long. */
export const ARMOUR_SLOTS = 4;

export interface ItemDef {
  id: ItemId;
  /** Registry name; what `give` and the save file use. */
  name: string;
  label: string;
  /** Largest stack. Tools are 1, everything else 64. */
  stack: number;
  /** The block this item places, or `Block.Air`. */
  block: Block;
  tool: ToolKind;
  tier: Tier;
  /** Uses before the tool breaks; 0 means it never wears out. */
  durability: number;
  shape: IconShape;
  /** sRGB 0..1, for the icon and for the dropped item's tint. */
  color: readonly [number, number, number];
  /** Where this is worn, or `ArmourSlot.None`. */
  armour: ArmourSlot;
  /**
   * Armour points, as in the reference: each one is four percent off incoming
   * damage, and a full iron set is fifteen of them.
   */
  defense: number;
  /** Hunger points this restores when eaten, or 0 for anything inedible. */
  food: number;
  /**
   * What this bucket holds, as a block id, or `Block.Air` for an empty one.
   *
   * A separate field rather than three unrelated items, because the two things
   * the game asks are "can I scoop with this" and "what comes out" — and both
   * are answered by one lookup.
   */
  holds: Block;
}

/** Linear reflectance to something a screen and an eye agree on. */
function toSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const DEFS: ItemDef[] = [];

function blockItem(block: Block): ItemDef {
  const def = BLOCKS[block];
  return {
    id: block,
    name: def.name,
    label: def.label,
    stack: 64,
    block,
    tool: ToolKind.None,
    tier: Tier.Hand,
    durability: 0,
    armour: ArmourSlot.None,
    defense: 0,
    food: 0,
    holds: Block.Air,
    shape: 'block',
    color: [
      toSrgb(BLOCK_ALBEDO[block * 3]),
      toSrgb(BLOCK_ALBEDO[block * 3 + 1]),
      toSrgb(BLOCK_ALBEDO[block * 3 + 2]),
    ],
  };
}

// Every block that can sit in a bag gets an item, at the same id.
for (let block = 0; block < Block.Count; block++) {
  DEFS[block] = blockItem(block as Block);
}
DEFS[Block.Air] = {
  ...blockItem(Block.Air), name: 'none', label: '—', stack: 0,
};

/** Ids of everything that is not a block start here. */
export const FIRST_ITEM_ID = Block.Count;

let nextId = FIRST_ITEM_ID;

function item(d: Partial<ItemDef> & { name: string; label: string; shape: IconShape }): ItemId {
  const id = nextId++;
  DEFS[id] = {
    id,
    stack: 64,
    block: Block.Air,
    tool: ToolKind.None,
    tier: Tier.Hand,
    durability: 0,
    armour: ArmourSlot.None,
    defense: 0,
    food: 0,
    holds: Block.Air,
    color: [0.7, 0.7, 0.7],
    ...d,
  };
  return id;
}

function tool(
  name: string, label: string, kind: ToolKind, tier: Tier,
  shape: IconShape, color: readonly [number, number, number],
): ItemId {
  return item({
    name, label, shape, color,
    stack: 1, tool: kind, tier, durability: TIER_DURABILITY[tier],
  });
}

/**
 * One set of armour: four pieces, the reference's defence points and
 * durabilities.
 *
 * Leather is missing because leather comes from cows and there are no mobs, so
 * the ladder starts at iron — which is also the point at which armour starts
 * being worth the iron.
 */
function armourSet(
  prefix: string, label: string, color: readonly [number, number, number],
  defense: readonly [number, number, number, number],
  durability: readonly [number, number, number, number],
): Record<'helmet' | 'chestplate' | 'leggings' | 'boots', ItemId> {
  const pieces = [
    ['helmet', 'шлем', ArmourSlot.Head, 'helmet'],
    ['chestplate', 'нагрудник', ArmourSlot.Chest, 'chestplate'],
    ['leggings', 'поножи', ArmourSlot.Legs, 'leggings'],
    ['boots', 'ботинки', ArmourSlot.Feet, 'boots'],
  ] as const;

  const out = {} as Record<'helmet' | 'chestplate' | 'leggings' | 'boots', ItemId>;
  for (const [name, ru, slot, shape] of pieces) {
    out[name] = item({
      name: `${prefix}_${name}`,
      label: `${label} ${ru}`,
      shape,
      color,
      stack: 1,
      armour: slot,
      defense: defense[slot],
      durability: durability[slot],
    });
  }
  return out;
}

const WOOD_COLOR = [0.68, 0.51, 0.30] as const;
const STONE_COLOR = [0.55, 0.55, 0.57] as const;
const IRON_COLOR = [0.82, 0.80, 0.78] as const;

export const Item = {
  Stick: item({ name: 'stick', label: 'Палка', shape: 'stick', color: [0.55, 0.40, 0.22] }),
  Coal: item({ name: 'coal', label: 'Уголь', shape: 'lump', color: [0.15, 0.15, 0.16] }),
  RawIron: item({ name: 'raw_iron', label: 'Сырое железо', shape: 'lump', color: [0.79, 0.66, 0.55] }),
  RawGold: item({ name: 'raw_gold', label: 'Сырое золото', shape: 'lump', color: [0.95, 0.76, 0.31] }),
  Diamond: item({ name: 'diamond', label: 'Алмаз', shape: 'lump', color: [0.36, 0.87, 0.87] }),

  // What comes out of a furnace.
  /**
   * The only food in the world.
   *
   * It comes off oak leaves, because that is the one food source the reference
   * has that needs neither a farm nor an animal — and there are no animals.
   * Four points, the reference's number.
   */
  Apple: item({ name: 'apple', label: 'Яблоко', shape: 'apple', color: [0.82, 0.14, 0.12], food: 4 }),

  Charcoal: item({ name: 'charcoal', label: 'Древесный уголь', shape: 'lump', color: [0.22, 0.19, 0.17] }),
  IronIngot: item({ name: 'iron_ingot', label: 'Железный слиток', shape: 'ingot', color: [0.86, 0.85, 0.83] }),
  GoldIngot: item({ name: 'gold_ingot', label: 'Золотой слиток', shape: 'ingot', color: [0.98, 0.80, 0.28] }),

  WoodenPickaxe: tool('wooden_pickaxe', 'Деревянная кирка', ToolKind.Pickaxe, Tier.Wood, 'pickaxe', WOOD_COLOR),
  WoodenShovel: tool('wooden_shovel', 'Деревянная лопата', ToolKind.Shovel, Tier.Wood, 'shovel', WOOD_COLOR),
  WoodenAxe: tool('wooden_axe', 'Деревянный топор', ToolKind.Axe, Tier.Wood, 'axe', WOOD_COLOR),

  StonePickaxe: tool('stone_pickaxe', 'Каменная кирка', ToolKind.Pickaxe, Tier.Stone, 'pickaxe', STONE_COLOR),
  StoneShovel: tool('stone_shovel', 'Каменная лопата', ToolKind.Shovel, Tier.Stone, 'shovel', STONE_COLOR),
  StoneAxe: tool('stone_axe', 'Каменный топор', ToolKind.Axe, Tier.Stone, 'axe', STONE_COLOR),

  IronPickaxe: tool('iron_pickaxe', 'Железная кирка', ToolKind.Pickaxe, Tier.Iron, 'pickaxe', IRON_COLOR),
  IronShovel: tool('iron_shovel', 'Железная лопата', ToolKind.Shovel, Tier.Iron, 'shovel', IRON_COLOR),
  IronAxe: tool('iron_axe', 'Железный топор', ToolKind.Axe, Tier.Iron, 'axe', IRON_COLOR),

  /**
   * The bucket, and the two things it can be full of.
   *
   * Three items rather than one with a state, because there is no item
   * metadata — the same reason the flowing fluids are separate block ids. The
   * `holds` field is what ties them together.
   */
  Bucket: item({
    name: 'bucket', label: 'Ведро', shape: 'bucket', stack: 16,
    color: [0.72, 0.72, 0.74],
  }),
  WaterBucket: item({
    name: 'water_bucket', label: 'Ведро воды', shape: 'bucket', stack: 1,
    color: [0.24, 0.45, 0.85], holds: Block.Water,
  }),
  LavaBucket: item({
    name: 'lava_bucket', label: 'Ведро лавы', shape: 'bucket', stack: 1,
    color: [0.95, 0.42, 0.10], holds: Block.Lava,
  }),

  Iron: armourSet('iron', 'Железный', IRON_COLOR, [2, 6, 5, 2], [165, 240, 225, 195]),
  Diamond_: armourSet('diamond', 'Алмазный', [0.44, 0.88, 0.86], [3, 8, 6, 3], [363, 528, 495, 429]),
} as const;

export const ITEMS: ReadonlyArray<ItemDef> = DEFS;

const BY_NAME = new Map<string, ItemId>();
for (const def of DEFS) if (def) BY_NAME.set(def.name, def.id);

export function itemDef(id: ItemId): ItemDef {
  return DEFS[id] ?? DEFS[NO_ITEM];
}

export function itemByName(name: string): ItemId {
  return BY_NAME.get(name) ?? NO_ITEM;
}

/** The item that places a block. Identity, by construction of the id space. */
export const itemForBlock = (block: Block): ItemId => block;

/** The block an item places, or `Block.Air`. */
export const blockOfItem = (id: ItemId): Block => DEFS[id]?.block ?? Block.Air;

export const isTool = (id: ItemId): boolean => (DEFS[id]?.durability ?? 0) > 0;

/** Where this item is worn, or `ArmourSlot.None`. */
export const armourSlotOf = (id: ItemId): ArmourSlot =>
  DEFS[id]?.armour ?? ArmourSlot.None;

/** Hunger points this restores, or 0 if it is not food. */
export const foodValue = (id: ItemId): number => DEFS[id]?.food ?? 0;

/** True for a bucket, full or empty. */
export const isBucket = (id: ItemId): boolean => DEFS[id]?.shape === 'bucket';

/** What a bucket holds, or `Block.Air`. */
export const bucketHolds = (id: ItemId): Block => DEFS[id]?.holds ?? Block.Air;

/** One stack in one slot. `damage` counts uses spent, and is 0 for anything but a tool. */
export interface ItemStack {
  id: ItemId;
  count: number;
  damage: number;
}

export const stack = (id: ItemId, count = 1, damage = 0): ItemStack => ({ id, count, damage });

/** Two stacks merge only if they are the same item *and* equally worn. */
export function sameItem(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.damage === b.damage;
}

export const maxStack = (id: ItemId): number => DEFS[id]?.stack ?? 64;

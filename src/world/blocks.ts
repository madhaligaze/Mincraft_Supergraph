/**
 * Block registry.
 *
 * Both the main thread and the mesher workers import this module, so the flat
 * lookup arrays at the bottom are the hot path: the mesher touches them once
 * per voxel face and must never go through an object property lookup.
 */

export const enum Block {
  Air = 0,
  Stone,
  Granite,
  Andesite,
  Dirt,
  GrassBlock,
  Podzol,
  Sand,
  RedSand,
  Gravel,
  Clay,
  Sandstone,
  SnowBlock,
  Ice,
  PackedIce,
  Bedrock,
  Cobblestone,
  MossyCobblestone,
  OakLog,
  OakLeaves,
  BirchLog,
  BirchLeaves,
  SpruceLog,
  SpruceLeaves,
  OakPlanks,
  CoalOre,
  IronOre,
  GoldOre,
  DiamondOre,
  Glowstone,
  Glass,
  Water,
  Lava,
  TallGrass,
  Fern,
  FlowerRed,
  FlowerYellow,
  FlowerBlue,
  DeadBush,
  Cactus,
  Count,
}

/** How the mesher emits geometry for a block. */
export const enum RenderKind {
  /** Emits nothing. */
  None = 0,
  /** Greedy-meshed axis-aligned faces. */
  Cube = 1,
  /** Two crossed quads, alpha-tested, wind-animated. */
  Cross = 2,
  /** Cube geometry routed to the water pass. */
  Liquid = 3,
  /** Cube geometry routed to the alpha-blended pass (glass). */
  Translucent = 4,
}

export const enum BlockFlag {
  /** Stops the player. */
  Solid = 1 << 0,
  /** Fully blocks skylight and blocklight propagation. */
  Opaque = 1 << 1,
  /** Culls the neighbouring face of an identical block (leaves do not). */
  CullsSameNeighbour = 1 << 2,
  /** Albedo is multiplied by the biome colour. */
  BiomeTinted = 1 << 3,
  /** Player can walk through it. */
  Passable = 1 << 4,
  /** Grass blades may be scattered on the top face. */
  GrowsGrass = 1 << 5,
  /** Swimmable volume. */
  Fluid = 1 << 6,
  /** Damages the player on contact. */
  Harmful = 1 << 7,
}

/** Face order used everywhere: +X, -X, +Y (top), -Y (bottom), +Z, -Z. */
export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

export const FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * Named material tiles. Each becomes one layer of the procedurally generated
 * texture array, so the order here is the layer order on the GPU.
 */
export const TEXTURES = [
  'stone', 'granite', 'andesite', 'dirt', 'grass_top', 'grass_side',
  'podzol_top', 'podzol_side', 'sand', 'red_sand', 'gravel', 'clay',
  'sandstone_top', 'sandstone_side', 'snow', 'ice', 'packed_ice', 'bedrock',
  'cobblestone', 'mossy_cobblestone',
  'oak_log_top', 'oak_log_side', 'oak_leaves',
  'birch_log_top', 'birch_log_side', 'birch_leaves',
  'spruce_log_top', 'spruce_log_side', 'spruce_leaves',
  'oak_planks',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'glowstone',
  'glass', 'water', 'lava',
  'tall_grass', 'fern', 'flower_red', 'flower_yellow', 'flower_blue',
  'dead_bush', 'cactus_top', 'cactus_side',
] as const;

export type TextureName = (typeof TEXTURES)[number];

const TEX_INDEX = new Map<TextureName, number>();
TEXTURES.forEach((name, i) => TEX_INDEX.set(name, i));

export function textureIndex(name: TextureName): number {
  const index = TEX_INDEX.get(name);
  if (index === undefined) throw new Error(`Неизвестная текстура: ${name}`);
  return index;
}

export interface BlockDef {
  id: Block;
  name: string;
  /** Localised label for the hotbar. */
  label: string;
  render: RenderKind;
  flags: number;
  /** [+X, -X, +Y, -Y, +Z, -Z]; a single name is used for all six. */
  textures: TextureName | [TextureName, TextureName, TextureName];
  /** 0..1 perceptual roughness. */
  roughness: number;
  metallic: number;
  /** 0..15 emitted light. */
  light: number;
  /** How many light levels this block subtracts when it is not opaque. */
  lightAttenuation: number;
  /** Selectable in the hotbar. */
  placeable: boolean;
  /** Relative hardness; drives the break animation timing. */
  hardness: number;
}

type PartialDef = Omit<Partial<BlockDef>, 'id' | 'name'> & {
  id: Block;
  name: string;
  label: string;
};

const SOLID_OPAQUE = BlockFlag.Solid | BlockFlag.Opaque | BlockFlag.CullsSameNeighbour;

function def(d: PartialDef): BlockDef {
  return {
    render: RenderKind.Cube,
    flags: SOLID_OPAQUE,
    textures: 'stone',
    roughness: 0.85,
    metallic: 0,
    light: 0,
    lightAttenuation: 15,
    placeable: true,
    hardness: 1,
    ...d,
  };
}

const DEFS: BlockDef[] = [];

function register(d: BlockDef): void {
  DEFS[d.id] = d;
}

register(def({
  id: Block.Air, name: 'air', label: 'Воздух',
  render: RenderKind.None, flags: BlockFlag.Passable,
  lightAttenuation: 0, placeable: false, hardness: 0,
}));

register(def({ id: Block.Stone, name: 'stone', label: 'Камень', textures: 'stone', roughness: 0.88, hardness: 1.5 }));
register(def({ id: Block.Granite, name: 'granite', label: 'Гранит', textures: 'granite', roughness: 0.8, hardness: 1.5 }));
register(def({ id: Block.Andesite, name: 'andesite', label: 'Андезит', textures: 'andesite', roughness: 0.86, hardness: 1.5 }));
register(def({ id: Block.Dirt, name: 'dirt', label: 'Земля', textures: 'dirt', roughness: 0.95, hardness: 0.5 }));

register(def({
  id: Block.GrassBlock, name: 'grass_block', label: 'Трава',
  textures: ['grass_side', 'grass_top', 'dirt'],
  flags: SOLID_OPAQUE | BlockFlag.BiomeTinted | BlockFlag.GrowsGrass,
  roughness: 0.92, hardness: 0.6,
}));

register(def({
  id: Block.Podzol, name: 'podzol', label: 'Подзол',
  textures: ['podzol_side', 'podzol_top', 'dirt'],
  flags: SOLID_OPAQUE | BlockFlag.GrowsGrass, roughness: 0.95, hardness: 0.5,
}));

register(def({ id: Block.Sand, name: 'sand', label: 'Песок', textures: 'sand', roughness: 0.9, hardness: 0.5 }));
register(def({ id: Block.RedSand, name: 'red_sand', label: 'Красный песок', textures: 'red_sand', roughness: 0.9, hardness: 0.5 }));
register(def({ id: Block.Gravel, name: 'gravel', label: 'Гравий', textures: 'gravel', roughness: 0.93, hardness: 0.6 }));
register(def({ id: Block.Clay, name: 'clay', label: 'Глина', textures: 'clay', roughness: 0.75, hardness: 0.6 }));

register(def({
  id: Block.Sandstone, name: 'sandstone', label: 'Песчаник',
  textures: ['sandstone_side', 'sandstone_top', 'sandstone_top'],
  roughness: 0.87, hardness: 0.8,
}));

register(def({ id: Block.SnowBlock, name: 'snow_block', label: 'Снег', textures: 'snow', roughness: 0.6, hardness: 0.2 }));

register(def({
  id: Block.Ice, name: 'ice', label: 'Лёд', textures: 'ice',
  render: RenderKind.Translucent,
  flags: BlockFlag.Solid | BlockFlag.CullsSameNeighbour,
  roughness: 0.08, lightAttenuation: 2, hardness: 0.5,
}));

register(def({ id: Block.PackedIce, name: 'packed_ice', label: 'Плотный лёд', textures: 'packed_ice', roughness: 0.15, hardness: 0.6 }));
register(def({ id: Block.Bedrock, name: 'bedrock', label: 'Бедрок', textures: 'bedrock', roughness: 0.95, placeable: false, hardness: 1e9 }));
register(def({ id: Block.Cobblestone, name: 'cobblestone', label: 'Булыжник', textures: 'cobblestone', roughness: 0.9, hardness: 1.5 }));
register(def({ id: Block.MossyCobblestone, name: 'mossy_cobblestone', label: 'Мшистый булыжник', textures: 'mossy_cobblestone', roughness: 0.92, hardness: 1.5 }));

register(def({
  id: Block.OakLog, name: 'oak_log', label: 'Дуб (бревно)',
  textures: ['oak_log_side', 'oak_log_top', 'oak_log_top'], roughness: 0.82, hardness: 1.0,
}));

/**
 * Leaves cull the face they share with another leaf block.
 *
 * The alternative — emitting every interior face so the canopy reads as a solid
 * volume — costs about six times the geometry, and canopies were more than half
 * of all the quads in a forest. Because the cutout pass is drawn double-sided,
 * looking through a gap in the near shell still shows the inside of the far
 * shell, so the canopy keeps its depth for a fraction of the vertex work.
 */
const LEAF_FLAGS = BlockFlag.Solid | BlockFlag.BiomeTinted | BlockFlag.CullsSameNeighbour;

register(def({
  id: Block.OakLeaves, name: 'oak_leaves', label: 'Листва дуба', textures: 'oak_leaves',
  flags: LEAF_FLAGS,
  render: RenderKind.Cube, roughness: 0.9, lightAttenuation: 2, hardness: 0.2,
}));

register(def({
  id: Block.BirchLog, name: 'birch_log', label: 'Берёза (бревно)',
  textures: ['birch_log_side', 'birch_log_top', 'birch_log_top'], roughness: 0.8, hardness: 1.0,
}));
register(def({
  id: Block.BirchLeaves, name: 'birch_leaves', label: 'Листва берёзы', textures: 'birch_leaves',
  flags: LEAF_FLAGS, roughness: 0.9, lightAttenuation: 2, hardness: 0.2,
}));
register(def({
  id: Block.SpruceLog, name: 'spruce_log', label: 'Ель (бревно)',
  textures: ['spruce_log_side', 'spruce_log_top', 'spruce_log_top'], roughness: 0.84, hardness: 1.0,
}));
register(def({
  id: Block.SpruceLeaves, name: 'spruce_leaves', label: 'Хвоя', textures: 'spruce_leaves',
  flags: LEAF_FLAGS, roughness: 0.88, lightAttenuation: 2, hardness: 0.2,
}));

register(def({ id: Block.OakPlanks, name: 'oak_planks', label: 'Доски', textures: 'oak_planks', roughness: 0.7, hardness: 1.0 }));

register(def({ id: Block.CoalOre, name: 'coal_ore', label: 'Уголь', textures: 'coal_ore', roughness: 0.9, hardness: 2.0 }));
register(def({ id: Block.IronOre, name: 'iron_ore', label: 'Железо', textures: 'iron_ore', roughness: 0.55, metallic: 0.35, hardness: 2.5 }));
register(def({ id: Block.GoldOre, name: 'gold_ore', label: 'Золото', textures: 'gold_ore', roughness: 0.35, metallic: 0.6, hardness: 2.5 }));
register(def({ id: Block.DiamondOre, name: 'diamond_ore', label: 'Алмаз', textures: 'diamond_ore', roughness: 0.2, metallic: 0.1, hardness: 3.0 }));

register(def({
  id: Block.Glowstone, name: 'glowstone', label: 'Светокамень', textures: 'glowstone',
  roughness: 0.55, light: 15, hardness: 0.5,
}));

register(def({
  id: Block.Glass, name: 'glass', label: 'Стекло', textures: 'glass',
  render: RenderKind.Translucent,
  flags: BlockFlag.Solid | BlockFlag.CullsSameNeighbour,
  roughness: 0.03, lightAttenuation: 0, hardness: 0.4,
}));

register(def({
  id: Block.Water, name: 'water', label: 'Вода', textures: 'water',
  render: RenderKind.Liquid,
  flags: BlockFlag.Passable | BlockFlag.Fluid | BlockFlag.CullsSameNeighbour,
  roughness: 0.02, lightAttenuation: 1, hardness: 1e9, placeable: true,
}));

register(def({
  id: Block.Lava, name: 'lava', label: 'Лава', textures: 'lava',
  render: RenderKind.Liquid,
  flags: BlockFlag.Passable | BlockFlag.Fluid | BlockFlag.Harmful,
  roughness: 0.6, light: 15, lightAttenuation: 1, hardness: 1e9,
}));

const CROSS_FLAGS = BlockFlag.Passable | BlockFlag.BiomeTinted;

register(def({
  id: Block.TallGrass, name: 'tall_grass', label: 'Высокая трава', textures: 'tall_grass',
  render: RenderKind.Cross, flags: CROSS_FLAGS, lightAttenuation: 0, roughness: 0.9, hardness: 0.05,
}));
register(def({
  id: Block.Fern, name: 'fern', label: 'Папоротник', textures: 'fern',
  render: RenderKind.Cross, flags: CROSS_FLAGS, lightAttenuation: 0, roughness: 0.9, hardness: 0.05,
}));
register(def({
  id: Block.FlowerRed, name: 'flower_red', label: 'Мак', textures: 'flower_red',
  render: RenderKind.Cross, flags: BlockFlag.Passable, lightAttenuation: 0, roughness: 0.8, hardness: 0.05,
}));
register(def({
  id: Block.FlowerYellow, name: 'flower_yellow', label: 'Одуванчик', textures: 'flower_yellow',
  render: RenderKind.Cross, flags: BlockFlag.Passable, lightAttenuation: 0, roughness: 0.8, hardness: 0.05,
}));
register(def({
  id: Block.FlowerBlue, name: 'flower_blue', label: 'Василёк', textures: 'flower_blue',
  render: RenderKind.Cross, flags: BlockFlag.Passable, lightAttenuation: 0, roughness: 0.8, hardness: 0.05,
}));
register(def({
  id: Block.DeadBush, name: 'dead_bush', label: 'Сухой куст', textures: 'dead_bush',
  render: RenderKind.Cross, flags: BlockFlag.Passable, lightAttenuation: 0, roughness: 0.95, hardness: 0.05,
}));

register(def({
  id: Block.Cactus, name: 'cactus', label: 'Кактус',
  textures: ['cactus_side', 'cactus_top', 'cactus_top'],
  flags: SOLID_OPAQUE | BlockFlag.Harmful, roughness: 0.85, hardness: 0.4,
}));

for (let id = 0; id < Block.Count; id++) {
  if (!DEFS[id]) throw new Error(`Блок ${id} не зарегистрирован`);
}

export const BLOCKS: ReadonlyArray<BlockDef> = DEFS;

// ---------------------------------------------------------------------------
// Flat lookup tables — the mesher and the lighting solver read only these.
// ---------------------------------------------------------------------------

export const BLOCK_RENDER = new Uint8Array(Block.Count);
export const BLOCK_FLAGS = new Uint8Array(Block.Count);
export const BLOCK_LIGHT = new Uint8Array(Block.Count);
export const BLOCK_ATTENUATION = new Uint8Array(Block.Count);
/** 6 texture layer indices per block, in FACE_* order. */
export const BLOCK_FACE_TEX = new Uint16Array(Block.Count * 6);
/** Roughness and metallic quantised to 0..255 for the vertex stream. */
export const BLOCK_ROUGHNESS = new Uint8Array(Block.Count);
export const BLOCK_METALLIC = new Uint8Array(Block.Count);
export const BLOCK_HARDNESS = new Float32Array(Block.Count);

for (const d of DEFS) {
  BLOCK_RENDER[d.id] = d.render;
  BLOCK_FLAGS[d.id] = d.flags;
  BLOCK_LIGHT[d.id] = d.light;
  BLOCK_ATTENUATION[d.id] = d.lightAttenuation;
  BLOCK_ROUGHNESS[d.id] = Math.round(d.roughness * 255);
  BLOCK_METALLIC[d.id] = Math.round(d.metallic * 255);
  BLOCK_HARDNESS[d.id] = d.hardness;

  const t = d.textures;
  const [side, top, bottom] = typeof t === 'string' ? [t, t, t] : t;
  const base = d.id * 6;
  BLOCK_FACE_TEX[base + FACE_PX] = textureIndex(side);
  BLOCK_FACE_TEX[base + FACE_NX] = textureIndex(side);
  BLOCK_FACE_TEX[base + FACE_PY] = textureIndex(top);
  BLOCK_FACE_TEX[base + FACE_NY] = textureIndex(bottom);
  BLOCK_FACE_TEX[base + FACE_PZ] = textureIndex(side);
  BLOCK_FACE_TEX[base + FACE_NZ] = textureIndex(side);
}

// --- predicates (inlined by the JIT; keep them tiny) ---

export const isAir = (id: number): boolean => id === Block.Air;
export const isOpaque = (id: number): boolean => (BLOCK_FLAGS[id] & BlockFlag.Opaque) !== 0;
export const isSolid = (id: number): boolean => (BLOCK_FLAGS[id] & BlockFlag.Solid) !== 0;
export const isFluid = (id: number): boolean => (BLOCK_FLAGS[id] & BlockFlag.Fluid) !== 0;
export const isPassable = (id: number): boolean => (BLOCK_FLAGS[id] & BlockFlag.Passable) !== 0;
export const isBiomeTinted = (id: number): boolean =>
  (BLOCK_FLAGS[id] & BlockFlag.BiomeTinted) !== 0;
export const growsGrass = (id: number): boolean => (BLOCK_FLAGS[id] & BlockFlag.GrowsGrass) !== 0;

/**
 * Whether the face of `self` touching `neighbour` should be emitted.
 *
 * The rule that matters: two identical translucent blocks hide their shared
 * face (glass, ice, water), but leaves never do, because a canopy needs its
 * internal faces to read as volume rather than a shell.
 */
export function shouldRenderFace(self: number, neighbour: number): boolean {
  const nRender = BLOCK_RENDER[neighbour];
  if (nRender === RenderKind.None) return true;
  if (BLOCK_FLAGS[neighbour] & BlockFlag.Opaque) return false;

  if (self === neighbour) {
    return (BLOCK_FLAGS[self] & BlockFlag.CullsSameNeighbour) === 0;
  }
  // Cross geometry never occludes a cube face.
  if (nRender === RenderKind.Cross) return true;
  // A solid block against water still draws: the water surface is separate.
  return true;
}

/** Hotbar contents, in order. */
export const HOTBAR: readonly Block[] = [
  Block.GrassBlock, Block.Stone, Block.Cobblestone, Block.OakPlanks,
  Block.OakLog, Block.Sand, Block.Glass, Block.Glowstone, Block.Water,
];

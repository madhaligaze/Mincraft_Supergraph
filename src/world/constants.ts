/**
 * World dimensions and the memory layout of a chunk column.
 *
 * A 32x32 footprint (rather than Minecraft's 16) halves the chunk count for a
 * given view distance, which matters more here than meshing granularity: on an
 * Intel iGPU the per-draw-call driver overhead dominates, so fewer and larger
 * chunk meshes win even though each remesh costs more.
 *
 * The 192-block height is deliberate. Terrain tops out around y=186 and the sea
 * sits at 62, so nothing is lost, and every column costs 25% less memory and
 * 25% less skylight propagation than a 256-tall world would.
 */

export const CHUNK_SIZE = 32;
export const CHUNK_SIZE_LOG2 = 5;
export const CHUNK_MASK = CHUNK_SIZE - 1;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

export const WORLD_HEIGHT = 192;

/** Vertical slice size for meshing and frustum culling. */
export const SECTION_HEIGHT = 32;
export const SECTION_COUNT = WORLD_HEIGHT / SECTION_HEIGHT;

export const BLOCKS_PER_COLUMN = CHUNK_AREA * WORLD_HEIGHT;

export const SEA_LEVEL = 62;
export const BEDROCK_HEIGHT = 4;

/**
 * Flat index into a column array: y-major, so a vertical scan (the skylight
 * pass, the heightmap pass) walks a fixed stride of 1024 and a horizontal
 * neighbour is +/-1 or +/-32.
 */
export const columnIndex = (x: number, y: number, z: number): number =>
  (y << 10) | (z << 5) | x;

export const MAX_LIGHT = 15;

// ---------------------------------------------------------------------------
// Column buffer layout
//
// One allocation per column holds every per-voxel and per-tile array. With
// SharedArrayBuffer this is what a worker receives: a single handle, no copies.
// ---------------------------------------------------------------------------

export const OFF_BLOCKS = 0;
export const LEN_BLOCKS = BLOCKS_PER_COLUMN;

/** High nibble = skylight, low nibble = block light. */
export const OFF_LIGHT = OFF_BLOCKS + LEN_BLOCKS;
export const LEN_LIGHT = BLOCKS_PER_COLUMN;

export const OFF_BIOME = OFF_LIGHT + LEN_LIGHT;
export const LEN_BIOME = CHUNK_AREA;

export const OFF_GRASS_TINT = OFF_BIOME + LEN_BIOME;
export const LEN_GRASS_TINT = CHUNK_AREA * 3;

export const OFF_FOLIAGE_TINT = OFF_GRASS_TINT + LEN_GRASS_TINT;
export const LEN_FOLIAGE_TINT = CHUNK_AREA * 3;

/** Int16 arrays start here; the offset is even, which satisfies alignment. */
export const OFF_HEIGHTMAP = OFF_FOLIAGE_TINT + LEN_FOLIAGE_TINT;
export const LEN_HEIGHTMAP = CHUNK_AREA * 2;

export const OFF_SOLID_HEIGHTMAP = OFF_HEIGHTMAP + LEN_HEIGHTMAP;
export const LEN_SOLID_HEIGHTMAP = CHUNK_AREA * 2;

export const COLUMN_BUFFER_BYTES = OFF_SOLID_HEIGHTMAP + LEN_SOLID_HEIGHTMAP;

/**
 * Packs chunk coordinates into one number usable as a Map key.
 * Range is +/-1,048,575 chunks, far past any reachable position.
 */
export const chunkKey = (cx: number, cz: number): number =>
  (cx + 0x100000) * 0x200000 + (cz + 0x100000);

export const keyToChunkX = (key: number): number =>
  Math.floor(key / 0x200000) - 0x100000;

export const keyToChunkZ = (key: number): number =>
  (key % 0x200000) - 0x100000;

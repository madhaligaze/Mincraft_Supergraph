/**
 * Chunk column storage.
 *
 * One buffer per column holds every per-voxel array. When SharedArrayBuffer is
 * available the buffer is shared, so a worker can read a neighbouring column
 * directly — that is what makes cross-chunk light propagation and border face
 * culling correct without shipping a padded copy with every job.
 *
 * The same `ColumnStore` type is used on the main thread and inside workers;
 * only the allocation site differs.
 */

import {
  CHUNK_AREA, CHUNK_MASK, CHUNK_SIZE, WORLD_HEIGHT, chunkKey, columnIndex,
  COLUMN_BUFFER_BYTES,
  OFF_BLOCKS, LEN_BLOCKS, OFF_LIGHT, LEN_LIGHT, OFF_BIOME, LEN_BIOME,
  OFF_GRASS_TINT, OFF_FOLIAGE_TINT, OFF_HEIGHTMAP, OFF_SOLID_HEIGHTMAP,
} from './constants.ts';
import { Block } from './blocks.ts';

/** True when the page is cross-origin isolated and SAB can be allocated. */
export const SHARED_MEMORY_AVAILABLE = (() => {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && new SharedArrayBuffer(8).byteLength === 8;
  } catch {
    return false;
  }
})();

export type ColumnBuffer = SharedArrayBuffer | ArrayBuffer;

export function allocateColumnBuffer(): ColumnBuffer {
  return SHARED_MEMORY_AVAILABLE
    ? new SharedArrayBuffer(COLUMN_BUFFER_BYTES)
    : new ArrayBuffer(COLUMN_BUFFER_BYTES);
}

/** Typed views over one column's backing buffer. */
export class ColumnData {
  readonly blocks: Uint8Array;
  readonly light: Uint8Array;
  readonly biome: Uint8Array;
  readonly grassTint: Uint8Array;
  readonly foliageTint: Uint8Array;
  readonly heightmap: Int16Array;
  readonly solidHeightmap: Int16Array;

  /** Set once terrain generation has run. */
  generated = false;
  /** Set once the light flood fill has run with all neighbours present. */
  lit = false;
  /** Per-section mesh revision; bumped on every edit to invalidate meshes. */
  readonly revision = new Uint32Array(WORLD_HEIGHT / 32);

  constructor(
    readonly x: number,
    readonly z: number,
    readonly buffer: ColumnBuffer,
  ) {
    this.blocks = new Uint8Array(buffer, OFF_BLOCKS, LEN_BLOCKS);
    this.light = new Uint8Array(buffer, OFF_LIGHT, LEN_LIGHT);
    this.biome = new Uint8Array(buffer, OFF_BIOME, LEN_BIOME);
    this.grassTint = new Uint8Array(buffer, OFF_GRASS_TINT, CHUNK_AREA * 3);
    this.foliageTint = new Uint8Array(buffer, OFF_FOLIAGE_TINT, CHUNK_AREA * 3);
    this.heightmap = new Int16Array(buffer, OFF_HEIGHTMAP, CHUNK_AREA);
    this.solidHeightmap = new Int16Array(buffer, OFF_SOLID_HEIGHTMAP, CHUNK_AREA);
  }

  getBlock(lx: number, y: number, lz: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return Block.Air;
    return this.blocks[columnIndex(lx, y, lz)];
  }

  setBlock(lx: number, y: number, lz: number, block: number): void {
    this.blocks[columnIndex(lx, y, lz)] = block;
  }

  getSkyLight(lx: number, y: number, lz: number): number {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 15;
    return this.light[columnIndex(lx, y, lz)] >> 4;
  }

  getBlockLight(lx: number, y: number, lz: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.light[columnIndex(lx, y, lz)] & 15;
  }
}

/**
 * A set of columns addressable by world coordinates.
 *
 * Reads outside any loaded column return air with full skylight, which is the
 * correct assumption for the empty space above and beside the loaded region.
 */
export class ColumnStore {
  private readonly columns = new Map<number, ColumnData>();

  /** Single-entry lookup cache; consecutive voxel reads almost always hit. */
  private cacheKey = -1;
  private cacheColumn: ColumnData | null = null;

  get size(): number {
    return this.columns.size;
  }

  keys(): IterableIterator<number> {
    return this.columns.keys();
  }

  values(): IterableIterator<ColumnData> {
    return this.columns.values();
  }

  get(cx: number, cz: number): ColumnData | undefined {
    const key = chunkKey(cx, cz);
    if (key === this.cacheKey) return this.cacheColumn ?? undefined;
    const column = this.columns.get(key);
    this.cacheKey = key;
    this.cacheColumn = column ?? null;
    return column;
  }

  getByKey(key: number): ColumnData | undefined {
    return this.columns.get(key);
  }

  has(cx: number, cz: number): boolean {
    return this.columns.has(chunkKey(cx, cz));
  }

  add(column: ColumnData): void {
    this.columns.set(chunkKey(column.x, column.z), column);
    this.invalidateCache();
  }

  remove(cx: number, cz: number): boolean {
    const removed = this.columns.delete(chunkKey(cx, cz));
    if (removed) this.invalidateCache();
    return removed;
  }

  clear(): void {
    this.columns.clear();
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.cacheKey = -1;
    this.cacheColumn = null;
  }

  /** True when the column and all eight of its horizontal neighbours exist. */
  hasNeighbourhood(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const column = this.get(cx + dx, cz + dz);
        if (!column || !column.generated) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // World-space voxel access
  // -------------------------------------------------------------------------

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return Block.Air;
    const column = this.get(x >> 5, z >> 5);
    if (!column) return Block.Air;
    return column.blocks[columnIndex(x & CHUNK_MASK, y, z & CHUNK_MASK)];
  }

  setBlock(x: number, y: number, z: number, block: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const column = this.get(x >> 5, z >> 5);
    if (!column) return false;
    column.blocks[columnIndex(x & CHUNK_MASK, y, z & CHUNK_MASK)] = block;
    return true;
  }

  /** Packed light byte: high nibble sky, low nibble block. */
  getLight(x: number, y: number, z: number): number {
    if (y < 0) return 0;
    // Above the world, full sky and no block light.
    if (y >= WORLD_HEIGHT) return 0xf0;
    const column = this.get(x >> 5, z >> 5);
    if (!column) return 0xf0;
    return column.light[columnIndex(x & CHUNK_MASK, y, z & CHUNK_MASK)];
  }

  setLight(x: number, y: number, z: number, packed: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const column = this.get(x >> 5, z >> 5);
    if (!column) return;
    column.light[columnIndex(x & CHUNK_MASK, y, z & CHUNK_MASK)] = packed;
  }

  getBiome(x: number, z: number): number {
    const column = this.get(x >> 5, z >> 5);
    if (!column) return 0;
    return column.biome[(z & CHUNK_MASK) * CHUNK_SIZE + (x & CHUNK_MASK)];
  }

  /** Highest non-air block in a column, or -1. */
  getHeight(x: number, z: number): number {
    const column = this.get(x >> 5, z >> 5);
    if (!column) return -1;
    return column.heightmap[(z & CHUNK_MASK) * CHUNK_SIZE + (x & CHUNK_MASK)];
  }
}

/** The message shape used to hand a column's memory to a worker. */
export interface ColumnHandle {
  x: number;
  z: number;
  buffer: ColumnBuffer;
}

export function handleOf(column: ColumnData): ColumnHandle {
  return { x: column.x, z: column.z, buffer: column.buffer };
}

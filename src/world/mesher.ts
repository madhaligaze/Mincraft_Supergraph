/**
 * Greedy voxel mesher with per-vertex ambient occlusion and smooth light.
 *
 * Design notes that matter for performance on an integrated GPU:
 *
 *  - Faces are merged into the largest rectangles that share an identical
 *    appearance (block, texture, AO at all four corners, light at all four
 *    corners). A flat grass field collapses from 1024 quads to 1.
 *  - Vertices are 12 bytes: 3x uint16 position at 1/8-block precision, 2x uint8
 *    tile UV, and one packed uint32. At ~20k vertices per section that is 240 KB
 *    of vertex traffic, which the shared memory bus can actually feed.
 *  - No index buffer is generated. Quads always emit four consecutive vertices,
 *    so every chunk in the world draws through one shared static index buffer
 *    of the pattern (0,1,2, 0,2,3). That removes an upload and a bind per chunk.
 */

import {
  BLOCK_FACE_TEX, BLOCK_FLAGS, BLOCK_RENDER, BLOCK_LIGHT, Block, BlockFlag,
  RenderKind, shouldRenderFace, FACE_PY, FACE_NY,
} from './blocks.ts';
import {
  CHUNK_SIZE, SECTION_HEIGHT, WORLD_HEIGHT, columnIndex, CHUNK_MASK,
} from './constants.ts';
import type { ColumnStore } from './storage.ts';
import { hash3i } from '../core/math.ts';

/**
 * Region spans the section plus one cell of neighbour data on every side.
 *
 * At full detail a cell is a voxel and the region is 34^3. A level-of-detail
 * mesh aggregates `step` voxels per cell, so it needs fewer cells; the buffers
 * are allocated for the largest case and the smaller ones reuse the front of
 * them.
 */
const MAX_R = SECTION_HEIGHT + 2; // 34
const MAX_R3 = MAX_R * MAX_R * MAX_R;

/** Decimation factors a section can be meshed at. */
export type LodStep = 1 | 2 | 4;

/** Level 0 is full detail; each level doubles the cell size. */
export const LOD_STEPS: readonly LodStep[] = [1, 2, 4];

export const VERTEX_STRIDE = 12;
/** Positions are stored in eighths of a block so cross-quads can be inset. */
export const POSITION_SCALE = 8;

/**
 * Constant added to every stored position, in POSITION_SCALE units (1 block).
 *
 * Positions live in an unsigned 16-bit attribute, but a cross-shaped plant at
 * the edge of a section legitimately extends up to ~0.6 blocks past it. Without
 * a bias those coordinates wrap to ~65535 and the quad is flung 8000 blocks
 * away, which draws as a thin line stretching across the whole sky.
 */
export const POSITION_BIAS = POSITION_SCALE;

export const enum TintMode {
  None = 0,
  Grass = 1,
  Foliage = 2,
}

/** Which draw bucket a quad belongs to. */
export const enum Bucket {
  Opaque = 0,
  /** Alpha-tested: leaves and cross-shaped plants. */
  Cutout = 1,
  Water = 2,
  /** Alpha-blended: glass and ice. */
  Translucent = 3,
  Count = 4,
}

export interface SectionMesh {
  /** Interleaved vertex data, 4 vertices per quad. */
  vertices: Uint8Array;
  quadCount: number;
}

export interface SectionMeshResult {
  chunkX: number;
  chunkZ: number;
  sectionY: number;
  /** Decimation this mesh was built at; 1 is full detail. */
  step: LodStep;
  buckets: (SectionMesh | null)[];
  /** Local-space AABB of the emitted geometry, or null when empty. */
  bounds: Float32Array | null;
  /** Emissive block positions (world space) + intensity, 4 floats each. */
  lights: Float32Array;
}

/** Growable interleaved vertex writer with three aligned views over one buffer. */
class VertexWriter {
  private buffer: ArrayBuffer;
  private u8: Uint8Array;
  private u16: Uint16Array;
  private u32: Uint32Array;
  vertexCount = 0;

  constructor(initialVertices = 4096) {
    this.buffer = new ArrayBuffer(initialVertices * VERTEX_STRIDE);
    this.u8 = new Uint8Array(this.buffer);
    this.u16 = new Uint16Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }

  reset(): void {
    this.vertexCount = 0;
  }

  private ensure(extra: number): void {
    const needed = (this.vertexCount + extra) * VERTEX_STRIDE;
    if (needed <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < needed) size *= 2;
    const grown = new ArrayBuffer(size);
    new Uint8Array(grown).set(this.u8);
    this.buffer = grown;
    this.u8 = new Uint8Array(grown);
    this.u16 = new Uint16Array(grown);
    this.u32 = new Uint32Array(grown);
  }

  /** `x`,`y`,`z` are already scaled by POSITION_SCALE; the bias is added here. */
  push(x: number, y: number, z: number, u: number, v: number, data: number): void {
    this.ensure(1);
    const i = this.vertexCount++;
    const b16 = i * 6;
    this.u16[b16] = x + POSITION_BIAS;
    this.u16[b16 + 1] = y + POSITION_BIAS;
    this.u16[b16 + 2] = z + POSITION_BIAS;
    const b8 = i * VERTEX_STRIDE + 6;
    this.u8[b8] = u;
    this.u8[b8 + 1] = v;
    this.u32[i * 3 + 2] = data;
  }

  take(): Uint8Array {
    return this.u8.slice(0, this.vertexCount * VERTEX_STRIDE);
  }
}

/**
 * Packs a vertex payload.
 *
 * bits  0..8   texture layer
 * bits  9..11  face index
 * bits 12..13  ambient occlusion, 0 = darkest
 * bits 14..17  skylight
 * bits 18..21  block light
 * bits 22..23  tint mode
 * bit  24      wind animation
 */
function packData(
  texLayer: number, face: number, ao: number,
  sky: number, blockLight: number, tint: number, wind: number,
): number {
  return (
    (texLayer & 0x1ff) |
    ((face & 7) << 9) |
    ((ao & 3) << 12) |
    ((sky & 15) << 14) |
    ((blockLight & 15) << 18) |
    ((tint & 3) << 22) |
    ((wind & 1) << 24)
  ) >>> 0;
}

/**
 * Tangent basis per face, chosen so that u x v equals the face normal and every
 * component is non-negative — the greedy sweep reconstructs voxel coordinates
 * as `origin + u*i + v*j`, which only works for non-negative axes.
 */
const FACE_BASIS: ReadonlyArray<{
  n: readonly [number, number, number];
  u: readonly [number, number, number];
  v: readonly [number, number, number];
}> = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },   // +X
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -X
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },   // +Y
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -Y
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },  // -Z
];

/**
 * Whether a face's texture UV must be transposed relative to its tangent basis.
 *
 * The non-negativity constraint above forces the world-vertical axis to land on
 * `u` for +X and -Z, but on `v` for -X and +Z. Without transposing the first
 * pair, every material with a vertical convention — the grass fringe, sandstone
 * bedding, plank rows, bark grain, cactus ribs — would appear rotated 90 degrees
 * on half the sides of every block.
 */
const FACE_SWAP_UV: ReadonlyArray<boolean> = [
  true,   // +X: vertical is u
  false,  // -X: vertical is v
  false,  // +Y
  false,  // -Y
  false,  // +Z: vertical is v
  true,   // -Z: vertical is u
];

export class Mesher {
  /** Padded block ids for the section being meshed. */
  private readonly blocks = new Uint8Array(MAX_R3);
  /** Padded packed light bytes. */
  private readonly light = new Uint8Array(MAX_R3);

  /** Voxels aggregated per cell for the mesh in progress. */
  private step: LodStep = 1;
  /** Cells per section side: 32, 16 or 8. */
  private span = SECTION_HEIGHT;
  /** Region side including the one-cell skirt. */
  private rs = MAX_R;
  private rs2 = MAX_R * MAX_R;


  private readonly writers: VertexWriter[] = [];

  // Greedy merge masks, indexed [v * SECTION_HEIGHT + u].
  private readonly maskBlock = new Int32Array(SECTION_HEIGHT * SECTION_HEIGHT);
  private readonly maskAO = new Uint8Array(SECTION_HEIGHT * SECTION_HEIGHT);
  private readonly maskSky = new Uint16Array(SECTION_HEIGHT * SECTION_HEIGHT);
  private readonly maskBlockLight = new Uint16Array(SECTION_HEIGHT * SECTION_HEIGHT);
  private readonly maskTint = new Uint8Array(SECTION_HEIGHT * SECTION_HEIGHT);
  private readonly maskDone = new Uint8Array(SECTION_HEIGHT * SECTION_HEIGHT);

  private readonly lightList: number[] = [];

  private minX = 0; private minY = 0; private minZ = 0;
  private maxX = 0; private maxY = 0; private maxZ = 0;
  private hasGeometry = false;

  constructor() {
    for (let i = 0; i < Bucket.Count; i++) this.writers.push(new VertexWriter());
  }

  /**
   * Meshes one 32^3 section. Requires the column and its eight neighbours to be
   * generated and lit.
   */
  mesh(
    store: ColumnStore,
    chunkX: number, chunkZ: number, sectionY: number,
    step: LodStep = 1,
  ): SectionMeshResult {
    for (const w of this.writers) w.reset();
    this.lightList.length = 0;
    this.hasGeometry = false;
    this.minX = this.minY = this.minZ = Number.POSITIVE_INFINITY;
    this.maxX = this.maxY = this.maxZ = Number.NEGATIVE_INFINITY;

    this.step = step;
    this.span = SECTION_HEIGHT / step;
    this.rs = this.span + 2;
    this.rs2 = this.rs * this.rs;

    if (step === 1) {
      this.gather(store, chunkX, chunkZ, sectionY);
      this.emitCubes();
      this.emitCrosses(chunkX, chunkZ, sectionY);
    } else {
      this.gatherLod(store, chunkX, chunkZ, sectionY);
      this.emitCubes();
      // Cross-shaped plants and emissive point lights are full-detail only:
      // at LOD range a blade of grass is well under a pixel, and the lights
      // are already gathered from the full-detail meshes nearer the camera.
    }

    const buckets: (SectionMesh | null)[] = [];
    for (let i = 0; i < Bucket.Count; i++) {
      const writer = this.writers[i];
      buckets.push(
        writer.vertexCount > 0
          ? { vertices: writer.take(), quadCount: writer.vertexCount >> 2 }
          : null,
      );
    }

    return {
      chunkX, chunkZ, sectionY, step,
      buckets,
      bounds: this.hasGeometry
        ? Float32Array.of(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ)
        : null,
      lights: Float32Array.from(this.lightList),
    };
  }

  /** Copies the section plus a 1-block skirt into the flat working arrays. */
  private gather(store: ColumnStore, chunkX: number, chunkZ: number, sectionY: number): void {
    const baseY = sectionY * SECTION_HEIGHT;
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;

    const own = store.get(chunkX, chunkZ);

    const R = MAX_R;
    const R2 = MAX_R * MAX_R;

    for (let ry = 0; ry < R; ry++) {
      const worldY = baseY + ry - 1;
      const rowBase = ry * R2;

      if (worldY < 0 || worldY >= WORLD_HEIGHT) {
        // Below bedrock is treated as solid so the bottom face is culled;
        // above the world is open sky.
        this.blocks.fill(worldY < 0 ? Block.Bedrock : Block.Air, rowBase, rowBase + R2);
        this.light.fill(worldY < 0 ? 0 : 0xf0, rowBase, rowBase + R2);
        continue;
      }

      for (let rz = 0; rz < R; rz++) {
        const worldZ = originZ + rz - 1;
        const dst = rowBase + rz * R;

        // The interior 32 blocks of the row are contiguous in the owning
        // column, so copy them wholesale and patch the two edges.
        if (own && rz >= 1 && rz <= CHUNK_SIZE) {
          const srcStart = columnIndex(0, worldY, rz - 1);
          this.blocks.set(own.blocks.subarray(srcStart, srcStart + CHUNK_SIZE), dst + 1);
          this.light.set(own.light.subarray(srcStart, srcStart + CHUNK_SIZE), dst + 1);

          this.copyCell(store, originX - 1, worldY, worldZ, dst);
          this.copyCell(store, originX + CHUNK_SIZE, worldY, worldZ, dst + R - 1);
          continue;
        }

        for (let rx = 0; rx < R; rx++) {
          this.copyCell(store, originX + rx - 1, worldY, worldZ, dst + rx);
        }
      }
    }
  }

  private copyCell(
    store: ColumnStore, x: number, y: number, z: number, dst: number,
  ): void {
    const column = store.get(x >> 5, z >> 5);
    if (!column) {
      // Unloaded neighbour: pretend it is solid so we do not emit a wall of
      // faces that will be hidden the moment the chunk arrives.
      this.blocks[dst] = Block.Stone;
      this.light[dst] = 0;
      return;
    }
    const index = columnIndex(x & CHUNK_MASK, y, z & CHUNK_MASK);
    this.blocks[dst] = column.blocks[index];
    this.light[dst] = column.light[index];
  }

  /** Index into the padded region, in cells. Valid for any decimation. */
  private ri(x: number, y: number, z: number): number {
    return (y + 1) * this.rs2 + (z + 1) * this.rs + (x + 1);
  }

  /**
   * Fills the region with aggregated cells for a level-of-detail mesh.
   *
   * Each cell stands for `step^3` voxels. The representative is the *topmost*
   * non-air block in the cell, because at LOD range what the eye reads is the
   * colour of the surface seen from above — taking the most common block
   * instead would paint grassy hills the colour of the dirt underneath them.
   *
   * A cell counts as solid only when at least half of it is, which keeps a
   * single stray block from inflating a whole cell and stops distant
   * silhouettes from growing.
   */
  private gatherLod(
    store: ColumnStore, chunkX: number, chunkZ: number, sectionY: number,
  ): void {
    const step = this.step;
    const rs = this.rs;
    const cellVoxels = step * step * step;
    const majority = cellVoxels >> 1;

    const baseY = sectionY * SECTION_HEIGHT;
    const originX = chunkX * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;

    for (let cy = 0; cy < rs; cy++) {
      const y0 = baseY + (cy - 1) * step;

      for (let cz = 0; cz < rs; cz++) {
        const z0 = originZ + (cz - 1) * step;

        for (let cx = 0; cx < rs; cx++) {
          const x0 = originX + (cx - 1) * step;
          const dst = cy * this.rs2 + cz * rs + cx;

          if (y0 + step <= 0) {
            // Below bedrock: solid, so the bottom face is culled.
            this.blocks[dst] = Block.Bedrock;
            this.light[dst] = 0;
            continue;
          }
          if (y0 >= WORLD_HEIGHT) {
            this.blocks[dst] = Block.Air;
            this.light[dst] = 0xf0;
            continue;
          }

          let solidCount = 0;
          let topBlock = Block.Air;
          let topY = -1;
          let maxSky = 0;
          let maxBlockLight = 0;

          for (let dy = 0; dy < step; dy++) {
            const y = y0 + dy;
            if (y < 0 || y >= WORLD_HEIGHT) continue;
            for (let dz = 0; dz < step; dz++) {
              for (let dx = 0; dx < step; dx++) {
                const column = store.get((x0 + dx) >> 5, (z0 + dz) >> 5);
                if (!column) continue;
                const index = columnIndex(
                  (x0 + dx) & CHUNK_MASK, y, (z0 + dz) & CHUNK_MASK,
                );
                const id = column.blocks[index];
                const packed = column.light[index];

                if (id !== Block.Air) {
                  solidCount++;
                  if (y > topY) {
                    topY = y;
                    topBlock = id;
                  }
                }
                const sky = packed >> 4;
                const blockLight = packed & 15;
                if (sky > maxSky) maxSky = sky;
                if (blockLight > maxBlockLight) maxBlockLight = blockLight;
              }
            }
          }

          const solid = solidCount > majority;
          this.blocks[dst] = solid ? topBlock : Block.Air;
          this.light[dst] = (maxSky << 4) | maxBlockLight;
        }
      }
    }
  }

  private isOpaqueAt(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.blocks[this.ri(x, y, z)]] & BlockFlag.Opaque) !== 0;
  }

  private growBounds(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    this.hasGeometry = true;
  }

  // -------------------------------------------------------------------------
  // Cube faces
  // -------------------------------------------------------------------------

  private emitCubes(): void {
    for (let face = 0; face < 6; face++) {
      this.emitFace(face);
    }
  }

  /**
   * Sweeps every slice perpendicular to `face`, builds the appearance mask and
   * greedily merges equal cells into rectangles.
   */
  private emitFace(face: number): void {
    const basis = FACE_BASIS[face];
    const [nx, ny, nz] = basis.n;
    const [ux, uy, uz] = basis.u;
    const [vx, vy, vz] = basis.v;

    // The slice axis is whichever component of the normal is non-zero.
    const S = this.span;

    for (let slice = 0; slice < S; slice++) {
      this.maskBlock.fill(0);
      this.maskDone.fill(0);
      let any = false;

      for (let vi = 0; vi < S; vi++) {
        for (let ui = 0; ui < S; ui++) {
          // Reconstruct the voxel coordinate from (slice, u, v).
          const x = Math.abs(nx) * slice + ux * ui + vx * vi;
          const y = Math.abs(ny) * slice + uy * ui + vy * vi;
          const z = Math.abs(nz) * slice + uz * ui + vz * vi;

          const self = this.blocks[this.ri(x, y, z)];
          const kind = BLOCK_RENDER[self];
          if (kind !== RenderKind.Cube && kind !== RenderKind.Liquid &&
            kind !== RenderKind.Translucent) {
            continue;
          }

          const neighbour = this.blocks[this.ri(x + nx, y + ny, z + nz)];
          if (!shouldRenderFace(self, neighbour)) continue;

          // A liquid face against more of the same liquid is never visible.
          //
          // This previously excluded the top face, so every block of a twenty
          // deep ocean emitted its own surface quad: twenty translucent planes
          // stacked in depth, fighting each other and slicing through the
          // shoreline blocks as a sawtooth of half-quad triangles. It was also
          // the reason the water pass could cost over a hundred milliseconds —
          // the overdraw was twenty layers deep.
          if (kind === RenderKind.Liquid) {
            if (BLOCK_RENDER[neighbour] === RenderKind.Liquid) continue;
            if (face === FACE_NY) continue;
          }

          const cell = vi * S + ui;
          this.maskBlock[cell] = self;
          this.computeCorners(x, y, z, face, cell);
          any = true;
        }
      }

      if (!any) continue;
      this.mergeMask(face, slice, basis);
    }
  }

  /**
   * Computes ambient occlusion and interpolated light for the four corners of
   * one face, packing them two bits (AO) and four bits (light) per corner.
   */
  private computeCorners(x: number, y: number, z: number, face: number, cell: number): void {
    if (this.step > 1) {
      // LOD meshes carry no per-vertex ambient occlusion and one light value
      // per cell. That is not only cheaper to compute — it is what lets greedy
      // meshing actually merge at distance, because the merge key collapses to
      // block plus tint and a flat hillside becomes a handful of quads instead
      // of hundreds.
      const packed = this.light[this.ri(x, y, z)];
      const sky = packed >> 4;
      const blockLight = packed & 15;
      this.maskAO[cell] = 0xff;                                  // ao = 3 at every corner
      this.maskSky[cell] = sky | (sky << 4) | (sky << 8) | (sky << 12);
      this.maskBlockLight[cell] =
        blockLight | (blockLight << 4) | (blockLight << 8) | (blockLight << 12);
      this.maskTint[cell] = this.tintFor(this.blocks[this.ri(x, y, z)], face);
      return;
    }

    const basis = FACE_BASIS[face];
    const [nx, ny, nz] = basis.n;
    const [ux, uy, uz] = basis.u;
    const [vx, vy, vz] = basis.v;

    // The air-side cell the face looks into.
    const ax = x + nx, ay = y + ny, az = z + nz;

    let aoBits = 0;
    let skyBits = 0;
    let blockBits = 0;

    // Corner order matches the quad winding: (0,0), (1,0), (1,1), (0,1).
    const CORNER_U = [0, 1, 1, 0];
    const CORNER_V = [0, 0, 1, 1];

    for (let c = 0; c < 4; c++) {
      // Map corner index to the -1/+1 offsets of the neighbours it touches.
      const du = CORNER_U[c] * 2 - 1;
      const dv = CORNER_V[c] * 2 - 1;

      const s1x = ax + ux * du, s1y = ay + uy * du, s1z = az + uz * du;
      const s2x = ax + vx * dv, s2y = ay + vy * dv, s2z = az + vz * dv;
      const cxx = s1x + vx * dv, cyy = s1y + vy * dv, czz = s1z + vz * dv;

      const side1 = this.isOpaqueAt(s1x, s1y, s1z);
      const side2 = this.isOpaqueAt(s2x, s2y, s2z);
      const corner = this.isOpaqueAt(cxx, cyy, czz);

      // The classic rule: two adjacent occluders fully close the corner.
      const ao = side1 && side2 ? 0 : 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));

      // Smooth light: average the light of the four cells around the corner,
      // ignoring the ones inside solid blocks.
      let skySum = 0, blockSum = 0, count = 0;
      const tap = (tx: number, ty: number, tz: number): void => {
        if (this.isOpaqueAt(tx, ty, tz)) return;
        const packed = this.light[this.ri(tx, ty, tz)];
        skySum += packed >> 4;
        blockSum += packed & 15;
        count++;
      };
      tap(ax, ay, az);
      tap(s1x, s1y, s1z);
      tap(s2x, s2y, s2z);
      tap(cxx, cyy, czz);

      const sky = count > 0 ? Math.round(skySum / count) : 0;
      const blockLight = count > 0 ? Math.round(blockSum / count) : 0;

      aoBits |= ao << (c * 2);
      skyBits |= sky << (c * 4);
      blockBits |= blockLight << (c * 4);
    }

    this.maskAO[cell] = aoBits;
    this.maskSky[cell] = skyBits;
    this.maskBlockLight[cell] = blockBits;

    const self = this.blocks[this.ri(x, y, z)];
    this.maskTint[cell] = this.tintFor(self, face);
  }

  private tintFor(block: number, face: number): number {
    if ((BLOCK_FLAGS[block] & BlockFlag.BiomeTinted) === 0) return TintMode.None;
    if (block === Block.GrassBlock) {
      // Only the top of a grass block takes the grass colour; the side texture
      // has its own baked overlay.
      return face === FACE_PY ? TintMode.Grass : TintMode.None;
    }
    return TintMode.Foliage;
  }

  /** Merges equal mask cells into maximal rectangles and emits their quads. */
  private mergeMask(
    face: number, slice: number,
    basis: { n: readonly [number, number, number]; u: readonly [number, number, number]; v: readonly [number, number, number] },
  ): void {
    const S = this.span;
    const [nx, ny, nz] = basis.n;
    const [ux, uy, uz] = basis.u;
    const [vx, vy, vz] = basis.v;

    for (let vi = 0; vi < S; vi++) {
      for (let ui = 0; ui < S; ui++) {
        const cell = vi * S + ui;
        const block = this.maskBlock[cell];
        if (block === 0 || this.maskDone[cell]) continue;

        const ao = this.maskAO[cell];
        const sky = this.maskSky[cell];
        const bl = this.maskBlockLight[cell];
        const tint = this.maskTint[cell];

        const matches = (other: number): boolean =>
          this.maskBlock[other] === block &&
          !this.maskDone[other] &&
          this.maskAO[other] === ao &&
          this.maskSky[other] === sky &&
          this.maskBlockLight[other] === bl &&
          this.maskTint[other] === tint;

        // Extend along u, then along v while the whole row still matches.
        let w = 1;
        while (ui + w < S && matches(cell + w)) w++;

        let h = 1;
        outer: while (vi + h < S) {
          const rowBase = (vi + h) * S + ui;
          for (let k = 0; k < w; k++) {
            if (!matches(rowBase + k)) break outer;
          }
          h++;
        }

        for (let dv = 0; dv < h; dv++) {
          this.maskDone.fill(1, (vi + dv) * S + ui, (vi + dv) * S + ui + w);
        }

        // Origin voxel of the merged rectangle.
        const x = Math.abs(nx) * slice + ux * ui + vx * vi;
        const y = Math.abs(ny) * slice + uy * ui + vy * vi;
        const z = Math.abs(nz) * slice + uz * ui + vz * vi;

        this.emitQuad(block, face, x, y, z, w, h, basis, ao, sky, bl, tint);
      }
    }
  }

  private emitQuad(
    block: number, face: number,
    x: number, y: number, z: number,
    w: number, h: number,
    basis: { n: readonly [number, number, number]; u: readonly [number, number, number]; v: readonly [number, number, number] },
    aoBits: number, skyBits: number, blockBits: number, tint: number,
  ): void {
    const [nx, ny, nz] = basis.n;
    const [ux, uy, uz] = basis.u;
    const [vx, vy, vz] = basis.v;

    const kind = BLOCK_RENDER[block];
    const bucket = kind === RenderKind.Liquid ? Bucket.Water
      : kind === RenderKind.Translucent ? Bucket.Translucent
        : (BLOCK_FLAGS[block] & BlockFlag.BiomeTinted) && block !== Block.GrassBlock
          ? Bucket.Cutout
          : Bucket.Opaque;

    const texLayer = BLOCK_FACE_TEX[block * 6 + face];

    // Face plane offset: +1 on the positive side, 0 on the negative side.
    const ox = nx > 0 ? 1 : 0;
    const oy = ny > 0 ? 1 : 0;
    const oz = nz > 0 ? 1 : 0;

    // Water sits a quarter of a block below the top so the surface reads as a
    // liquid rather than a solid cube flush with the shore. A quarter rather
    // than an eighth on purpose: the wave displacement adds up to 0.085, and
    // anything closer let the surface land near-coplanar with the block tops
    // along the shoreline, where it z-fought them into a sawtooth of
    // half-quad triangles.
    const drop = kind === RenderKind.Liquid && face === FACE_PY ? -2 : 0;

    // Cell coordinates become block coordinates by scaling with the decimation.
    const step = this.step;
    const P = POSITION_SCALE * step;
    const bx = (x + ox) * P;
    const by = (y + oy) * P + drop;
    const bz = (z + oz) * P;

    // Tile coordinates follow the quad's own u/v extent, transposed for the
    // faces whose vertical axis is u (see FACE_SWAP_UV).
    const swap = FACE_SWAP_UV[face];
    const uv = (a: number, b: number): [number, number] => (swap ? [b, a] : [a, b]);

    // Tile the material once per *block*, not once per cell, so texel density
    // stays the same at every level of detail.
    const tw = w * step;
    const th = h * step;
    const [u0, v0] = uv(0, 0);
    const [u1, v1] = uv(tw, 0);
    const [u2, v2] = uv(tw, th);
    const [u3, v3] = uv(0, th);

    const corners: Array<[number, number, number, number, number]> = [
      [bx, by, bz, u0, v0],
      [bx + ux * w * P, by + uy * w * P, bz + uz * w * P, u1, v1],
      [
        bx + (ux * w + vx * h) * P,
        by + (uy * w + vy * h) * P,
        bz + (uz * w + vz * h) * P,
        u2, v2,
      ],
      [bx + vx * h * P, by + vy * h * P, bz + vz * h * P, u3, v3],
    ];

    const ao = [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
    const sky = [skyBits & 15, (skyBits >> 4) & 15, (skyBits >> 8) & 15, (skyBits >> 12) & 15];
    const bl = [blockBits & 15, (blockBits >> 4) & 15, (blockBits >> 8) & 15, (blockBits >> 12) & 15];

    // The shared index buffer always splits a quad along the 0-2 diagonal.
    // When that diagonal is the darker one the shading develops a visible
    // crease, so rotate the vertices by one to move the split to 1-3.
    const rotate = ao[0] + ao[2] > ao[1] + ao[3] ? 1 : 0;

    const writer = this.writers[bucket];
    for (let i = 0; i < 4; i++) {
      const c = (i + rotate) & 3;
      const [px, py, pz, u, v] = corners[c];
      writer.push(
        px, py, pz, u, v,
        packData(texLayer, face, ao[c], sky[c], bl[c], tint, 0),
      );
    }

    // Every basis vector has only non-negative components, so the rectangle's
    // far corner is simply origin + u*w + v*h. Bounds are in blocks.
    this.growBounds((x + ox) * step, (y + oy) * step, (z + oz) * step);
    this.growBounds(
      (x + ox + ux * w + vx * h) * step,
      (y + oy + uy * w + vy * h) * step,
      (z + oz + uz * w + vz * h) * step,
    );
  }

  // -------------------------------------------------------------------------
  // Cross-shaped plants
  // -------------------------------------------------------------------------

  /**
   * Plants are two quads crossing at the block centre, drawn double-sided by
   * the cutout pass and displaced by the wind term in the vertex shader.
   */
  private emitCrosses(chunkX: number, chunkZ: number, sectionY: number): void {
    const writer = this.writers[Bucket.Cutout];
    const S = SECTION_HEIGHT;
    const baseY = sectionY * SECTION_HEIGHT;
    const P = POSITION_SCALE;

    for (let y = 0; y < S; y++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const block = this.blocks[this.ri(x, y, z)];

          if (BLOCK_LIGHT[block] > 0) {
            this.lightList.push(
              chunkX * CHUNK_SIZE + x + 0.5,
              baseY + y + 0.5,
              chunkZ * CHUNK_SIZE + z + 0.5,
              BLOCK_LIGHT[block],
            );
          }

          if (BLOCK_RENDER[block] !== RenderKind.Cross) continue;

          const packed = this.light[this.ri(x, y, z)];
          const sky = packed >> 4;
          const bl = packed & 15;
          const tint = (BLOCK_FLAGS[block] & BlockFlag.BiomeTinted) ? TintMode.Grass : TintMode.None;
          const texLayer = BLOCK_FACE_TEX[block * 6];

          // Deterministic per-block offset and rotation so a field of grass
          // does not look like a lattice.
          const h = hash3i(chunkX * CHUNK_SIZE + x, baseY + y, chunkZ * CHUNK_SIZE + z);
          const jitterX = (((h & 15) / 15) - 0.5) * 0.4;
          const jitterZ = ((((h >> 8) & 15) / 15) - 0.5) * 0.4;
          // Below one block: a plant that fills its whole cell reads as a solid
          // sheet rather than as something growing out of the ground.
          const scale = 0.68 + ((h >> 16) & 7) / 7 * 0.28;

          const cx = (x + 0.5 + jitterX) * P;
          const cy = y * P;
          const cz = (z + 0.5 + jitterZ) * P;
          const half = 0.5 * scale * P;
          const top = scale * P;

          // Two diagonal quads. Wind flag is set on the upper vertices only,
          // so the base stays planted.
          const dataBottom = packData(texLayer, FACE_PY, 3, sky, bl, tint, 0);
          const dataTop = packData(texLayer, FACE_PY, 3, sky, bl, tint, 1);

          for (let q = 0; q < 2; q++) {
            const dx = q === 0 ? half : half;
            const dz = q === 0 ? half : -half;
            writer.push(cx - dx, cy, cz - dz, 0, 0, dataBottom);
            writer.push(cx + dx, cy, cz + dz, 1, 0, dataBottom);
            writer.push(cx + dx, cy + top, cz + dz, 1, 1, dataTop);
            writer.push(cx - dx, cy + top, cz - dz, 0, 1, dataTop);
          }

          this.growBounds(x, y, z);
          this.growBounds(x + 1, y + 1, z + 1);
        }
      }
    }
  }
}

/**
 * Builds the shared quad index buffer contents.
 * Every chunk mesh draws through this, so it is generated once.
 */
export function buildQuadIndices(maxQuads: number): Uint32Array {
  const indices = new Uint32Array(maxQuads * 6);
  for (let q = 0; q < maxQuads; q++) {
    const v = q * 4;
    const i = q * 6;
    indices[i] = v;
    indices[i + 1] = v + 1;
    indices[i + 2] = v + 2;
    indices[i + 3] = v;
    indices[i + 4] = v + 2;
    indices[i + 5] = v + 3;
  }
  return indices;
}

/**
 * GPU storage for chunk section meshes.
 *
 * All sections share one static index buffer holding the repeating quad pattern
 * (0,1,2, 0,2,3). Because the mesher always emits four consecutive vertices per
 * quad, no chunk needs an index buffer of its own — that removes one buffer
 * upload and one bind per section, which on a driver with high per-call
 * overhead is worth more than it sounds.
 */

import { Bucket, VERTEX_STRIDE, buildQuadIndices, type SectionMeshResult } from '../world/mesher.ts';
import { SECTION_COUNT, SECTION_HEIGHT, CHUNK_SIZE, chunkKey } from '../world/constants.ts';
import type { Frustum } from '../core/math.ts';
import type { GLState } from './gl.ts';

interface BucketMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  quadCount: number;
  /** Allocated size in bytes, so a smaller remesh can reuse the buffer. */
  capacity: number;
}

export interface SectionRender {
  cx: number;
  cz: number;
  sy: number;
  originX: number;
  originY: number;
  originZ: number;
  /** World-space AABB of the emitted geometry. */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  buckets: (BucketMesh | null)[];
}

/** One entry of a per-frame draw list. */
export interface DrawItem {
  section: SectionRender;
  mesh: BucketMesh;
  /** Squared distance from the camera to the section centre. */
  distanceSq: number;
}

export class ChunkGeometry {
  private readonly sections = new Map<number, SectionRender>();
  private indexBuffer: WebGLBuffer;
  private indexCapacityQuads = 0;

  /** Reused draw lists, one per bucket. */
  private readonly lists: DrawItem[][] = [];

  totalQuads = 0;
  visibleQuads = 0;
  visibleDraws = 0;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly state: GLState) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Не удалось создать индексный буфер');
    this.indexBuffer = buffer;
    this.growIndexBuffer(16384);

    for (let i = 0; i < Bucket.Count; i++) this.lists.push([]);
  }

  private growIndexBuffer(quads: number): void {
    if (quads <= this.indexCapacityQuads) return;
    const gl = this.gl;
    // Round up generously; regrowing means re-uploading the whole thing.
    const target = Math.max(quads, this.indexCapacityQuads * 2, 16384);
    const data = buildQuadIndices(target);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    this.indexCapacityQuads = target;
    // Every VAO stores the element-array binding, so they all still reference
    // the same buffer object; only its contents changed.
  }

  private sectionKey(cx: number, cz: number, sy: number): number {
    return chunkKey(cx, cz) * SECTION_COUNT + sy;
  }

  upload(result: SectionMeshResult): void {
    const gl = this.gl;
    const key = this.sectionKey(result.chunkX, result.chunkZ, result.sectionY);

    let maxQuads = 0;
    for (const bucket of result.buckets) {
      if (bucket) maxQuads = Math.max(maxQuads, bucket.quadCount);
    }
    this.growIndexBuffer(maxQuads);

    let section = this.sections.get(key);
    if (!section) {
      section = {
        cx: result.chunkX,
        cz: result.chunkZ,
        sy: result.sectionY,
        originX: result.chunkX * CHUNK_SIZE,
        originY: result.sectionY * SECTION_HEIGHT,
        originZ: result.chunkZ * CHUNK_SIZE,
        minX: 0, minY: 0, minZ: 0,
        maxX: 0, maxY: 0, maxZ: 0,
        buckets: [null, null, null, null],
      };
      this.sections.set(key, section);
    }

    const bounds = result.bounds;
    if (bounds) {
      // One block of padding: cross-shaped plants and wind displacement push
      // geometry slightly past the voxel bounds the mesher recorded, and a
      // tight box would pop them out at the edge of the frustum.
      const pad = 1;
      section.minX = section.originX + bounds[0] - pad;
      section.minY = section.originY + bounds[1] - pad;
      section.minZ = section.originZ + bounds[2] - pad;
      section.maxX = section.originX + bounds[3] + pad;
      section.maxY = section.originY + bounds[4] + pad;
      section.maxZ = section.originZ + bounds[5] + pad;
    }

    for (let b = 0; b < Bucket.Count; b++) {
      const data = result.buckets[b];
      const existing = section.buckets[b];

      if (!data || data.quadCount === 0) {
        if (existing) {
          this.totalQuads -= existing.quadCount;
          this.deleteMesh(existing);
          section.buckets[b] = null;
        }
        continue;
      }

      const bytes = data.vertices.byteLength;

      if (existing) {
        this.totalQuads -= existing.quadCount;
        gl.bindBuffer(gl.ARRAY_BUFFER, existing.vbo);
        if (bytes <= existing.capacity) {
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.vertices);
        } else {
          gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
          existing.capacity = bytes;
        }
        existing.quadCount = data.quadCount;
        this.totalQuads += data.quadCount;
        continue;
      }

      section.buckets[b] = this.createMesh(data.vertices, data.quadCount);
      this.totalQuads += data.quadCount;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.state.invalidate();
  }

  private createMesh(vertices: Uint8Array, quadCount: number): BucketMesh {
    const gl = this.gl;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Не удалось создать буфер геометрии чанка');

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // location 0: uvec3 position, eighths of a block
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_SHORT, VERTEX_STRIDE, 0);
    // location 1: uvec2 tile UV
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_BYTE, VERTEX_STRIDE, 6);
    // location 2: packed payload
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, VERTEX_STRIDE, 8);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    return { vao, vbo, quadCount, capacity: vertices.byteLength };
  }

  private deleteMesh(mesh: BucketMesh): void {
    this.gl.deleteVertexArray(mesh.vao);
    this.gl.deleteBuffer(mesh.vbo);
  }

  discardSection(cx: number, cz: number, sy: number): void {
    const key = this.sectionKey(cx, cz, sy);
    const section = this.sections.get(key);
    if (!section) return;
    for (const mesh of section.buckets) {
      if (mesh) {
        this.totalQuads -= mesh.quadCount;
        this.deleteMesh(mesh);
      }
    }
    this.sections.delete(key);
  }

  discardColumn(cx: number, cz: number): void {
    for (let sy = 0; sy < SECTION_COUNT; sy++) this.discardSection(cx, cz, sy);
  }

  /**
   * Builds the per-bucket draw lists for this frame.
   *
   * Opaque geometry is sorted front to back so early-Z rejects as much as
   * possible; water and translucent geometry are sorted back to front because
   * blending is order dependent.
   */
  cull(frustum: Frustum, cameraX: number, cameraY: number, cameraZ: number): void {
    for (const list of this.lists) list.length = 0;
    this.visibleQuads = 0;
    this.visibleDraws = 0;

    for (const section of this.sections.values()) {
      if (!frustum.intersectsAABB(
        section.minX, section.minY, section.minZ,
        section.maxX, section.maxY, section.maxZ,
      )) continue;

      const centreX = (section.minX + section.maxX) * 0.5;
      const centreY = (section.minY + section.maxY) * 0.5;
      const centreZ = (section.minZ + section.maxZ) * 0.5;
      const dx = centreX - cameraX;
      const dy = centreY - cameraY;
      const dz = centreZ - cameraZ;
      const distanceSq = dx * dx + dy * dy + dz * dz;

      for (let b = 0; b < Bucket.Count; b++) {
        const mesh = section.buckets[b];
        if (!mesh) continue;
        this.lists[b].push({ section, mesh, distanceSq });
        this.visibleQuads += mesh.quadCount;
        this.visibleDraws++;
      }
    }

    this.lists[Bucket.Opaque].sort((a, b) => a.distanceSq - b.distanceSq);
    this.lists[Bucket.Cutout].sort((a, b) => a.distanceSq - b.distanceSq);
    this.lists[Bucket.Water].sort((a, b) => b.distanceSq - a.distanceSq);
    this.lists[Bucket.Translucent].sort((a, b) => b.distanceSq - a.distanceSq);
  }

  /** Draw list for shadow rendering: everything in the light frustum. */
  cullForShadow(frustum: Frustum, out: DrawItem[], buckets: Bucket[]): void {
    out.length = 0;
    for (const section of this.sections.values()) {
      if (!frustum.intersectsAABB(
        section.minX, section.minY, section.minZ,
        section.maxX, section.maxY, section.maxZ,
      )) continue;

      for (const b of buckets) {
        const mesh = section.buckets[b];
        if (mesh) out.push({ section, mesh, distanceSq: 0 });
      }
    }
  }

  list(bucket: Bucket): DrawItem[] {
    return this.lists[bucket];
  }

  get sectionCount(): number {
    return this.sections.size;
  }

  dispose(): void {
    for (const section of this.sections.values()) {
      for (const mesh of section.buckets) {
        if (mesh) this.deleteMesh(mesh);
      }
    }
    this.sections.clear();
    this.gl.deleteBuffer(this.indexBuffer);
  }
}

/**
 * Chunk streaming and the job scheduler that feeds the workers.
 *
 * The dependency chain is strict, and enforcing it is what makes chunks correct
 * on their first build instead of needing a re-mesh once neighbours arrive:
 *
 *   generate  -> no dependencies
 *   light     -> the 3x3 neighbourhood is generated
 *   mesh      -> the 3x3 neighbourhood is lit
 *
 * Because meshing needs lit neighbours and lighting needs generated
 * neighbours, columns are loaded two rings wider than the render distance and
 * only the inner region is ever meshed.
 */

import {
  CHUNK_SIZE, CHUNK_MASK, SECTION_COUNT, SECTION_HEIGHT, WORLD_HEIGHT,
  SEA_LEVEL, chunkKey, columnIndex, CHUNK_AREA,
} from './constants.ts';
import {
  ColumnData, ColumnStore, allocateColumnBuffer, handleOf,
  SHARED_MEMORY_AVAILABLE, type ColumnHandle,
} from './storage.ts';
import { ChunkPipeline } from './pipeline.ts';
import { TerrainGenerator } from './generator.ts';
import type { SectionMeshResult } from './mesher.ts';
import type { WorkerRequest, WorkerResponse } from './chunkWorker.ts';
import { Block, BLOCK_FLAGS, BlockFlag, isOpaque, growsGrass, BLOCK_LIGHT } from './blocks.ts';
import { BIOMES, BIOME_WATER_RGB } from './biomes.ts';
import { hash2i } from '../core/math.ts';

const enum Stage {
  Empty = 0,
  Generating = 1,
  Generated = 2,
  Lighting = 3,
  Lit = 4,
}

interface ColumnState {
  stage: Stage;
  /** Bit per section: mesh needs rebuilding. */
  dirtySections: number;
  /** Bit per section: a mesh job is in flight. */
  pendingSections: number;
  /** Atlas tiles have been handed to the renderer. */
  atlasUploaded: boolean;
  /** Squared distance from the camera in chunks, refreshed each update. */
  priority: number;
}

/** Where finished chunk data goes. Implemented by the renderer. */
export interface MeshSink {
  uploadSection(result: SectionMeshResult): void;
  discardSection(cx: number, cz: number, sectionY: number): void;
  discardColumn(cx: number, cz: number): void;
  /**
   * Uploads one column's tile into the toroidal atlas.
   * Layers: 0 grass tint, 1 foliage tint, 2 water tint, 3 surface info.
   */
  uploadAtlasTile(cx: number, cz: number, layers: Uint8Array[]): void;
}

export interface WorldStats {
  columns: number;
  generated: number;
  lit: number;
  pendingJobs: number;
  workers: number;
  shared: boolean;
}

interface Job {
  kind: 'generate' | 'light' | 'mesh';
  cx: number;
  cz: number;
  sectionY: number;
  priority: number;
}

/** Result of a voxel raycast. */
export interface RaycastHit {
  x: number;
  y: number;
  z: number;
  block: number;
  /** Face normal of the hit surface. */
  nx: number;
  ny: number;
  nz: number;
  distance: number;
}

const MAX_INFLIGHT_PER_WORKER = 3;

export class World {
  readonly store = new ColumnStore();
  readonly seed: number;

  private readonly states = new Map<number, ColumnState>();
  private readonly workers: Worker[] = [];
  private readonly workerLoad: number[] = [];
  private readonly inflight = new Map<number, Job>();
  private nextJobId = 1;

  /** Used only when SharedArrayBuffer is unavailable. */
  private readonly localPipeline: ChunkPipeline | null;

  private readonly jobQueue: Job[] = [];
  private queueDirty = true;

  renderDistance = 8;
  /** Columns are kept this many rings beyond the render distance. */
  private readonly loadMargin = 2;

  private cameraChunkX = 0;
  private cameraChunkZ = 0;

  private sink: MeshSink | null = null;
  private readonly atlasScratch: Uint8Array[] = [
    new Uint8Array(CHUNK_AREA * 4),
    new Uint8Array(CHUNK_AREA * 4),
    new Uint8Array(CHUNK_AREA * 4),
    new Uint8Array(CHUNK_AREA * 4),
  ];

  /** Emissive block positions gathered from finished meshes. */
  private readonly sectionLights = new Map<number, Float32Array>();

  /**
   * Finished meshes waiting to be handed to the GPU.
   *
   * Six workers can land a dozen results in a single frame, and every upload is
   * a synchronous `bufferData` on the main thread. Uploading them all as they
   * arrive is what turned a steady 56 fps into a 19 fps first-percentile, so
   * they are drained under a per-frame budget instead.
   */
  private readonly uploadQueue: SectionMeshResult[] = [];

  constructor(seed: number, workerCount: number) {
    this.seed = seed;

    if (SHARED_MEMORY_AVAILABLE && workerCount > 0) {
      this.localPipeline = null;
      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker(new URL('./chunkWorker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onWorkerMessage(event.data);
        worker.postMessage({ type: 'init', seed } satisfies WorkerRequest);
        this.workers.push(worker);
        this.workerLoad.push(0);
      }
    } else {
      // Without cross-origin isolation the workers cannot share the world, so
      // everything runs on the main thread under a per-frame time budget.
      this.localPipeline = new ChunkPipeline(seed);
    }
  }

  get usingWorkers(): boolean {
    return this.workers.length > 0;
  }

  setSink(sink: MeshSink): void {
    this.sink = sink;
  }

  stats(): WorldStats {
    let generated = 0;
    let lit = 0;
    for (const state of this.states.values()) {
      if (state.stage >= Stage.Generated) generated++;
      if (state.stage >= Stage.Lit) lit++;
    }
    return {
      columns: this.states.size,
      generated,
      lit,
      pendingJobs: this.jobQueue.length + this.inflight.size,
      workers: this.workers.length,
      shared: SHARED_MEMORY_AVAILABLE,
    };
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.states.clear();
    this.store.clear();
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /** Call once per frame with the camera position. `budgetMs` bounds the
   * single-threaded fallback path. */
  update(cameraX: number, cameraZ: number, budgetMs: number): void {
    const cx = Math.floor(cameraX) >> 5;
    const cz = Math.floor(cameraZ) >> 5;

    if (cx !== this.cameraChunkX || cz !== this.cameraChunkZ) {
      this.cameraChunkX = cx;
      this.cameraChunkZ = cz;
      this.queueDirty = true;
    }

    this.ensureLoaded();
    this.unloadDistant();

    if (this.queueDirty) {
      this.rebuildQueue();
      this.queueDirty = false;
    }

    if (this.usingWorkers) this.dispatchToWorkers();
    else this.runLocally(budgetMs);

    this.drainUploads();
  }

  /**
   * Hands finished meshes to the renderer, a few per frame.
   *
   * The budget is in milliseconds rather than a fixed count because a section
   * can be anything from one quad to twenty thousand, and it is the byte count
   * that costs.
   */
  private drainUploads(): void {
    if (this.uploadQueue.length === 0 || !this.sink) return;

    // A long queue means the world is still streaming in — a bigger budget
    // there fills the view faster, and there is no steady frame rate to
    // protect yet. Once caught up, the budget tightens so an arriving chunk
    // cannot cost a visible hitch.
    const budget = this.uploadQueue.length > 48 ? 7 : 2.5;
    const deadline = performance.now() + budget;
    let uploaded = 0;

    while (this.uploadQueue.length > 0) {
      const result = this.uploadQueue.shift();
      if (!result) break;

      // A column unloaded while its mesh was in flight has nothing to attach to.
      const state = this.states.get(chunkKey(result.chunkX, result.chunkZ));
      if (!state) continue;

      this.sink.uploadSection(result);
      uploaded++;

      // Always let at least one through, so a heavy section cannot stall the
      // queue forever behind its own cost.
      if (uploaded > 0 && performance.now() >= deadline) break;
    }
  }

  /** Creates column buffers for everything inside the load radius. */
  private ensureLoaded(): void {
    const radius = this.renderDistance + this.loadMargin;
    const newHandles: ColumnHandle[] = [];

    // Spiral outward so the columns nearest the camera exist first.
    for (let ring = 0; ring <= radius; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;

          const cx = this.cameraChunkX + dx;
          const cz = this.cameraChunkZ + dz;
          const key = chunkKey(cx, cz);
          if (this.states.has(key)) continue;

          const column = new ColumnData(cx, cz, allocateColumnBuffer());
          this.store.add(column);
          this.states.set(key, {
            stage: Stage.Empty,
            dirtySections: 0,
            pendingSections: 0,
            atlasUploaded: false,
            priority: dx * dx + dz * dz,
          });
          newHandles.push(handleOf(column));
          this.queueDirty = true;
        }
      }
    }

    if (newHandles.length > 0 && this.usingWorkers) {
      const message: WorkerRequest = { type: 'register', columns: newHandles };
      for (const worker of this.workers) worker.postMessage(message);
    }
  }

  private unloadDistant(): void {
    const limit = this.renderDistance + this.loadMargin + 2;
    const removed: Array<{ x: number; z: number }> = [];

    for (const [key, state] of this.states) {
      const column = this.store.getByKey(key);
      if (!column) {
        this.states.delete(key);
        continue;
      }
      const dx = Math.abs(column.x - this.cameraChunkX);
      const dz = Math.abs(column.z - this.cameraChunkZ);
      if (Math.max(dx, dz) <= limit) continue;

      // A column with work in flight has to wait: the worker still holds a
      // reference to its buffer.
      if (state.pendingSections !== 0) continue;
      if (state.stage === Stage.Generating || state.stage === Stage.Lighting) continue;

      this.sink?.discardColumn(column.x, column.z);
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        this.sectionLights.delete(this.sectionKey(column.x, column.z, sy));
      }
      this.store.remove(column.x, column.z);
      this.states.delete(key);
      removed.push({ x: column.x, z: column.z });
    }

    if (removed.length > 0) {
      this.queueDirty = true;
      if (this.usingWorkers) {
        const message: WorkerRequest = { type: 'unregister', columns: removed };
        for (const worker of this.workers) worker.postMessage(message);
      }
    }
  }

  /** Collects every runnable job and sorts by distance from the camera. */
  private rebuildQueue(): void {
    this.jobQueue.length = 0;
    const meshRadius = this.renderDistance;

    for (const [key, state] of this.states) {
      const column = this.store.getByKey(key);
      if (!column) continue;

      const dx = column.x - this.cameraChunkX;
      const dz = column.z - this.cameraChunkZ;
      state.priority = dx * dx + dz * dz;

      if (state.stage === Stage.Empty) {
        this.jobQueue.push({
          kind: 'generate', cx: column.x, cz: column.z, sectionY: 0, priority: state.priority,
        });
        continue;
      }

      if (state.stage === Stage.Generated && this.neighbourhoodAtLeast(column.x, column.z, Stage.Generated)) {
        this.jobQueue.push({
          kind: 'light', cx: column.x, cz: column.z, sectionY: 0, priority: state.priority,
        });
        continue;
      }

      if (state.stage !== Stage.Lit) continue;
      if (Math.max(Math.abs(dx), Math.abs(dz)) > meshRadius) continue;
      if (!this.neighbourhoodAtLeast(column.x, column.z, Stage.Lit)) continue;

      const todo = state.dirtySections & ~state.pendingSections;
      if (todo === 0) continue;

      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if ((todo & (1 << sy)) === 0) continue;
        this.jobQueue.push({
          kind: 'mesh', cx: column.x, cz: column.z, sectionY: sy, priority: state.priority,
        });
      }
    }

    // Generation first, then lighting, then meshing, each by distance. Doing
    // it in this order keeps the pipeline fed instead of finishing meshes for
    // one column while the next has not started generating.
    const rank: Record<Job['kind'], number> = { generate: 0, light: 1, mesh: 2 };
    this.jobQueue.sort((a, b) => {
      const kindDelta = rank[a.kind] - rank[b.kind];
      if (kindDelta !== 0) return kindDelta;
      return a.priority - b.priority;
    });
  }

  private neighbourhoodAtLeast(cx: number, cz: number, stage: Stage): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const state = this.states.get(chunkKey(cx + dx, cz + dz));
        if (!state || state.stage < stage) return false;
      }
    }
    return true;
  }

  private dispatchToWorkers(): void {
    const capacity = this.workers.length * MAX_INFLIGHT_PER_WORKER;

    while (this.inflight.size < capacity && this.jobQueue.length > 0) {
      const job = this.jobQueue.shift();
      if (!job) break;
      if (!this.jobStillValid(job)) continue;

      // Least-loaded worker.
      let best = 0;
      for (let i = 1; i < this.workerLoad.length; i++) {
        if (this.workerLoad[i] < this.workerLoad[best]) best = i;
      }
      if (this.workerLoad[best] >= MAX_INFLIGHT_PER_WORKER) break;

      const id = this.nextJobId++;
      this.inflight.set(id, job);
      this.workerLoad[best]++;
      this.markJobStarted(job);

      const message: WorkerRequest = job.kind === 'mesh'
        ? { type: 'mesh', id, cx: job.cx, cz: job.cz, sectionY: job.sectionY }
        : job.kind === 'light'
          ? { type: 'light', id, cx: job.cx, cz: job.cz }
          : { type: 'generate', id, cx: job.cx, cz: job.cz };

      this.workers[best].postMessage(message);
      // Remember which worker owns the job so its load can be released.
      (job as Job & { worker?: number }).worker = best;
    }
  }

  private jobStillValid(job: Job): boolean {
    const state = this.states.get(chunkKey(job.cx, job.cz));
    if (!state) return false;
    if (job.kind === 'generate') return state.stage === Stage.Empty;
    if (job.kind === 'light') return state.stage === Stage.Generated;
    return state.stage === Stage.Lit && (state.dirtySections & (1 << job.sectionY)) !== 0;
  }

  private markJobStarted(job: Job): void {
    const state = this.states.get(chunkKey(job.cx, job.cz));
    if (!state) return;
    if (job.kind === 'generate') state.stage = Stage.Generating;
    else if (job.kind === 'light') state.stage = Stage.Lighting;
    else state.pendingSections |= 1 << job.sectionY;
  }

  private onWorkerMessage(message: WorkerResponse): void {
    if (message.type === 'ready') return;

    const job = this.inflight.get(message.id);
    if (job) {
      this.inflight.delete(message.id);
      const worker = (job as Job & { worker?: number }).worker;
      if (worker !== undefined) this.workerLoad[worker] = Math.max(0, this.workerLoad[worker] - 1);
    }

    switch (message.type) {
      case 'generated':
        this.onGenerated(message.cx, message.cz, message.ok);
        break;
      case 'lit':
        this.onLit(message.cx, message.cz, message.ok);
        break;
      case 'meshed':
        this.onMeshed(message.cx, message.cz, message.sectionY, message.result);
        break;
      default:
        break;
    }
  }

  private onGenerated(cx: number, cz: number, ok: boolean): void {
    const state = this.states.get(chunkKey(cx, cz));
    if (!state) return;
    const column = this.store.get(cx, cz);
    if (column) column.generated = true;
    state.stage = ok || column?.generated ? Stage.Generated : Stage.Empty;
    this.queueDirty = true;
  }

  private onLit(cx: number, cz: number, ok: boolean): void {
    const state = this.states.get(chunkKey(cx, cz));
    if (!state) return;
    if (!ok) {
      // Neighbours were not ready; fall back and retry next pass.
      state.stage = Stage.Generated;
      this.queueDirty = true;
      return;
    }

    const column = this.store.get(cx, cz);
    if (column) column.lit = true;
    state.stage = Stage.Lit;
    state.dirtySections = (1 << SECTION_COUNT) - 1;

    if (!state.atlasUploaded && column) {
      this.uploadAtlas(column);
      state.atlasUploaded = true;
    }

    this.queueDirty = true;
  }

  private onMeshed(
    cx: number, cz: number, sectionY: number, result: SectionMeshResult | null,
  ): void {
    const state = this.states.get(chunkKey(cx, cz));
    if (!state) return;

    state.pendingSections &= ~(1 << sectionY);
    state.dirtySections &= ~(1 << sectionY);

    if (!result) return;

    const key = this.sectionKey(cx, cz, sectionY);
    if (result.lights.length > 0) this.sectionLights.set(key, result.lights);
    else this.sectionLights.delete(key);

    if (result.bounds) this.uploadQueue.push(result);
    else this.sink?.discardSection(cx, cz, sectionY);

    this.queueDirty = true;
  }

  private sectionKey(cx: number, cz: number, sy: number): number {
    return chunkKey(cx, cz) * SECTION_COUNT + sy;
  }

  /** Single-threaded fallback: runs jobs directly under a time budget. */
  private runLocally(budgetMs: number): void {
    const pipeline = this.localPipeline;
    if (!pipeline) return;

    const deadline = performance.now() + budgetMs;

    while (this.jobQueue.length > 0 && performance.now() < deadline) {
      const job = this.jobQueue.shift();
      if (!job || !this.jobStillValid(job)) continue;

      if (job.kind === 'generate') {
        const ok = pipeline.generate(this.store, job.cx, job.cz);
        this.onGenerated(job.cx, job.cz, ok);
      } else if (job.kind === 'light') {
        const ok = pipeline.light(this.store, job.cx, job.cz);
        this.onLit(job.cx, job.cz, ok);
      } else {
        const state = this.states.get(chunkKey(job.cx, job.cz));
        if (state) state.pendingSections |= 1 << job.sectionY;
        const result = pipeline.mesh(this.store, job.cx, job.cz, job.sectionY);
        this.onMeshed(job.cx, job.cz, job.sectionY, result);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tint / surface atlas
  // -------------------------------------------------------------------------

  /**
   * Builds the four atlas tiles for a column.
   *
   * Layer 3 is what the grass and rain shaders read to place themselves: red is
   * the terrain height in blocks, green a material id, blue the skylight there.
   * Keeping it in the same toroidal atlas means vegetation needs no geometry
   * and no per-frame upload of its own.
   */
  private uploadAtlas(column: ColumnData): void {
    const [grass, foliage, water, surface] = this.atlasScratch;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const area = lz * CHUNK_SIZE + lx;
        const out = area * 4;

        grass[out] = column.grassTint[area * 3];
        grass[out + 1] = column.grassTint[area * 3 + 1];
        grass[out + 2] = column.grassTint[area * 3 + 2];
        grass[out + 3] = 255;

        foliage[out] = column.foliageTint[area * 3];
        foliage[out + 1] = column.foliageTint[area * 3 + 1];
        foliage[out + 2] = column.foliageTint[area * 3 + 2];
        foliage[out + 3] = 255;

        const biome = column.biome[area];
        water[out] = Math.round(BIOME_WATER_RGB[biome * 3] * 255);
        water[out + 1] = Math.round(BIOME_WATER_RGB[biome * 3 + 1] * 255);
        water[out + 2] = Math.round(BIOME_WATER_RGB[biome * 3 + 2] * 255);
        water[out + 3] = 255;

        const height = column.solidHeightmap[area];
        let material = 0;
        let sky = 0;
        if (height >= 0 && height < WORLD_HEIGHT) {
          const top = column.blocks[columnIndex(lx, height, lz)];
          // Grass only grows where a blade would actually be visible: on a
          // grass-topped block with nothing sitting on it.
          const above = height + 1 < WORLD_HEIGHT
            ? column.blocks[columnIndex(lx, height + 1, lz)]
            : Block.Air;
          if (growsGrass(top) && above === Block.Air && BIOMES[biome].grassDensity > 0.02) {
            material = 1;
          }
          sky = height + 1 < WORLD_HEIGHT
            ? (column.light[columnIndex(lx, height + 1, lz)] >> 4) * 17
            : 255;
        }

        surface[out] = Math.max(0, Math.min(255, height));
        surface[out + 1] = material;
        surface[out + 2] = sky;
        surface[out + 3] = 255;
      }
    }

    this.sink?.uploadAtlasTile(column.x, column.z, this.atlasScratch);
  }

  // -------------------------------------------------------------------------
  // Lights
  // -------------------------------------------------------------------------

  /**
   * Nearest emissive blocks, as flat [x, y, z, intensity] tuples.
   * The renderer promotes these to real point lights for specular and falloff
   * the baked light channel cannot express.
   */
  collectNearbyLights(x: number, y: number, z: number, max: number, out: Float32Array): number {
    const candidates: Array<{ d: number; i: number; array: Float32Array }> = [];

    for (const [, lights] of this.sectionLights) {
      for (let i = 0; i < lights.length; i += 4) {
        const dx = lights[i] - x;
        const dy = lights[i + 1] - y;
        const dz = lights[i + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > 64 * 64) continue;
        candidates.push({ d, i, array: lights });
      }
    }

    candidates.sort((a, b) => a.d - b.d);
    const count = Math.min(max, candidates.length);
    for (let n = 0; n < count; n++) {
      const { i, array } = candidates[n];
      out[n * 4] = array[i];
      out[n * 4 + 1] = array[i + 1];
      out[n * 4 + 2] = array[i + 2];
      out[n * 4 + 3] = array[i + 3];
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  getBlock(x: number, y: number, z: number): number {
    return this.store.getBlock(x, y, z);
  }

  /** Places or removes a block and schedules the affected sections. */
  setBlock(x: number, y: number, z: number, block: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 5;
    const cz = z >> 5;
    const column = this.store.get(cx, cz);
    const state = this.states.get(chunkKey(cx, cz));
    if (!column || !state || state.stage !== Stage.Lit) return false;

    const lx = x & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    const previous = column.blocks[columnIndex(lx, y, lz)];
    if (previous === block) return false;

    column.blocks[columnIndex(lx, y, lz)] = block;
    this.refreshHeightmaps(column, lx, lz);

    // Relight this column and any neighbour whose 4-block light skirt reaches
    // the edit, then re-mesh everything that could have changed.
    const relightRadius = BLOCK_LIGHT[previous] > 0 || BLOCK_LIGHT[block] > 0 ? 1 : 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 && lx > 4 && lx < CHUNK_SIZE - 5 && relightRadius === 0) continue;
        if (dz !== 0 && lz > 4 && lz < CHUNK_SIZE - 5 && relightRadius === 0) continue;
        this.markForRelight(cx + dx, cz + dz);
      }
    }

    this.markSectionsDirtyAround(x, y, z);
    this.queueDirty = true;
    return true;
  }

  private markForRelight(cx: number, cz: number): void {
    const state = this.states.get(chunkKey(cx, cz));
    if (!state || state.stage !== Stage.Lit) return;
    const column = this.store.get(cx, cz);
    if (column) column.lit = false;
    state.stage = Stage.Generated;
  }

  /** Marks the edited section plus any neighbour whose border geometry moved. */
  private markSectionsDirtyAround(x: number, y: number, z: number): void {
    const lx = x & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    const ly = y % SECTION_HEIGHT;
    const sy = Math.floor(y / SECTION_HEIGHT);

    const dirty = (cx: number, cz: number, section: number): void => {
      if (section < 0 || section >= SECTION_COUNT) return;
      const state = this.states.get(chunkKey(cx, cz));
      if (!state) return;
      state.dirtySections |= 1 << section;
    };

    const cx = x >> 5;
    const cz = z >> 5;

    dirty(cx, cz, sy);
    if (lx === 0) dirty(cx - 1, cz, sy);
    if (lx === CHUNK_MASK) dirty(cx + 1, cz, sy);
    if (lz === 0) dirty(cx, cz - 1, sy);
    if (lz === CHUNK_MASK) dirty(cx, cz + 1, sy);
    if (ly === 0) dirty(cx, cz, sy - 1);
    if (ly === SECTION_HEIGHT - 1) dirty(cx, cz, sy + 1);
  }

  private refreshHeightmaps(column: ColumnData, lx: number, lz: number): void {
    const area = lz * CHUNK_SIZE + lx;
    let top = -1;
    let solid = -1;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const b = column.blocks[columnIndex(lx, y, lz)];
      if (b === Block.Air) continue;
      if (top < 0) top = y;
      if (isOpaque(b)) {
        solid = y;
        break;
      }
    }
    column.heightmap[area] = top;
    column.solidHeightmap[area] = solid;

    // The surface atlas tile drives grass placement, so it has to follow edits.
    const state = this.states.get(chunkKey(column.x, column.z));
    if (state) state.atlasUploaded = false;
  }

  /**
   * Marks every atlas tile as needing re-upload.
   *
   * The renderer throws the atlas texture away when the render distance
   * changes, so without this the biome tints and the grass placement map would
   * silently stay blank for every column already loaded.
   */
  invalidateAtlases(): void {
    for (const state of this.states.values()) state.atlasUploaded = false;
  }

  /** Re-uploads atlas tiles invalidated by edits. Call once per frame. */
  refreshAtlases(): void {
    for (const [key, state] of this.states) {
      if (state.atlasUploaded || state.stage < Stage.Lit) continue;
      const column = this.store.getByKey(key);
      if (!column) continue;
      this.uploadAtlas(column);
      state.atlasUploaded = true;
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Voxel raycast (Amanatides & Woo).
   * Returns the first non-passable block along the ray, with the face it hit.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    includeFluids = false,
  ): RaycastHit | null {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

    const boundary = (o: number, i: number, step: number): number =>
      step > 0 ? i + 1 - o : o - i;

    let tMaxX = stepX !== 0 ? boundary(ox, x, stepX) * tDeltaX : Infinity;
    let tMaxY = stepY !== 0 ? boundary(oy, y, stepY) * tDeltaY : Infinity;
    let tMaxZ = stepZ !== 0 ? boundary(oz, z, stepZ) * tDeltaZ : Infinity;

    let nx = 0, ny = 0, nz = 0;
    let travelled = 0;

    // A generous iteration cap; the distance test is the real terminator.
    for (let i = 0; i < 512; i++) {
      const block = this.store.getBlock(x, y, z);
      const passable = (BLOCK_FLAGS[block] & BlockFlag.Passable) !== 0;
      const fluid = (BLOCK_FLAGS[block] & BlockFlag.Fluid) !== 0;

      if (block !== Block.Air && (!passable || (includeFluids && fluid))) {
        return { x, y, z, block, nx, ny, nz, distance: travelled };
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        travelled = tMaxX;
        x += stepX;
        tMaxX += tDeltaX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        travelled = tMaxY;
        y += stepY;
        tMaxY += tDeltaY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        travelled = tMaxZ;
        z += stepZ;
        tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }

      if (travelled > maxDistance) break;
      if (y < 0 || y >= WORLD_HEIGHT) break;
    }

    return null;
  }

  /** True when the voxel stops the player. */
  isSolidAt(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    const block = this.store.getBlock(x, y, z);
    return (BLOCK_FLAGS[block] & BlockFlag.Solid) !== 0;
  }

  isFluidAt(x: number, y: number, z: number): boolean {
    const block = this.store.getBlock(x, y, z);
    return (BLOCK_FLAGS[block] & BlockFlag.Fluid) !== 0;
  }

  /** True when the column at this position has finished loading. */
  isReadyAt(x: number, z: number): boolean {
    const state = this.states.get(chunkKey(x >> 5, z >> 5));
    return state !== undefined && state.stage === Stage.Lit;
  }

  /**
   * A generator on the main thread, for queries that must answer before any
   * chunk has loaded. Deterministic from the seed, so it agrees exactly with
   * whatever the workers produce.
   */
  private queryGenerator: TerrainGenerator | null = null;

  private getQueryGenerator(): TerrainGenerator {
    if (this.localPipeline) return this.localPipeline.generator;
    this.queryGenerator ??= new TerrainGenerator(this.seed);
    return this.queryGenerator;
  }

  /**
   * Picks a spawn point: scans outward for a dry, reasonably flat, above-water
   * surface.
   */
  findSpawn(): { x: number; y: number; z: number } {
    const generator = this.getQueryGenerator();

    for (let radius = 0; radius < 4000; radius += 24) {
      const samples = radius === 0 ? 1 : 12;
      for (let i = 0; i < samples; i++) {
        const angle = (i / samples) * Math.PI * 2 + hash2i(radius, i) * 1e-9;
        const x = Math.round(Math.cos(angle) * radius);
        const z = Math.round(Math.sin(angle) * radius);

        const height = generator.surfaceHeightAt(x, z);
        if (height <= SEA_LEVEL + 2 || height > SEA_LEVEL + 55) continue;

        // Reject steep ground so the player does not spawn inside a cliff.
        const hx = generator.surfaceHeightAt(x + 3, z);
        const hz = generator.surfaceHeightAt(x, z + 3);
        if (Math.abs(hx - height) > 3 || Math.abs(hz - height) > 3) continue;

        return { x: x + 0.5, y: Math.ceil(height) + 2, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: SEA_LEVEL + 12, z: 0.5 };
  }
}

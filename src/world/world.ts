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
  SEA_LEVEL, chunkKey, keyToChunkX, keyToChunkZ, columnIndex, CHUNK_AREA,
} from './constants.ts';
import {
  ColumnData, ColumnStore, allocateColumnBuffer, handleOf,
  SHARED_MEMORY_AVAILABLE, type ColumnHandle,
} from './storage.ts';
import { ChunkPipeline } from './pipeline.ts';
import { TerrainGenerator } from './generator.ts';
import type { SectionMeshResult, LodStep } from './mesher.ts';
import type { WorkerRequest, WorkerResponse } from './chunkWorker.ts';
import type { GiRequest, GiResponse } from './giWorker.ts';
import { GI_CELL, GI_SIZE_XZ, type GiResult } from './gi.ts';
import type { WorldSave, SavedState } from './persistence.ts';
import { Block, BLOCK_FLAGS, BlockFlag, isOpaque, growsGrass, BLOCK_LIGHT } from './blocks.ts';
import { FluidSim } from './fluids.ts';
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
  /** Decimation this column's meshes are being built at. */
  lodStep: LodStep;
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
  /** Uploads a freshly baked indirect-light grid. */
  uploadGiVolume(result: GiResult): void;
}

export interface WorldStats {
  columns: number;
  generated: number;
  lit: number;
  pendingJobs: number;
  workers: number;
  shared: boolean;
  /** Milliseconds the last indirect-light bake took; 0 when it is off. */
  giBakeMs: number;
  /** Player edits held in the save. */
  savedEdits: number;
}

interface Job {
  kind: 'generate' | 'light' | 'mesh';
  cx: number;
  cz: number;
  sectionY: number;
  priority: number;
  step: LodStep;
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
  lodEnabled = true;
  /** Chunk distance past which sections are meshed two blocks per cell. */
  lodNearChunks = 5;
  /** Chunk distance past which sections are meshed four blocks per cell. */
  lodFarChunks = 7;

  /**
   * Picks a decimation for a column, moving at most one level at a time and
   * only once the distance is clear of the threshold by a margin.
   *
   * Without that margin a player walking back and forth across a boundary
   * would make the column re-mesh every few frames, and the visible pop
   * between levels would flicker continuously.
   */
  private lodStepFor(distanceChunks: number, current: LodStep): LodStep {
    if (!this.lodEnabled) return 1;

    const near = this.lodNearChunks;
    const far = Math.max(this.lodFarChunks, near + 1);
    const margin = 0.14;

    if (current === 1) return distanceChunks > near * (1 + margin) ? 2 : 1;
    if (current === 2) {
      if (distanceChunks < near * (1 - margin)) return 1;
      if (distanceChunks > far * (1 + margin)) return 4;
      return 2;
    }
    return distanceChunks < far * (1 - margin) ? 2 : 4;
  }
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

  // --- indirect light ---

  /** Off until the renderer asks for it; the bake is not free. */
  giEnabled = false;
  private giWorker: Worker | null = null;
  private giInflight = false;
  private giJobId = 1;
  /** Grid origin of the last bake, in cells. */
  private giOriginX = Number.NaN;
  private giOriginZ = Number.NaN;
  /** Seconds until the grid is rebuilt even if the player has not moved. */
  private giTimer = 0;
  /** Milliseconds the last bake took, for the stats overlay. */
  giBakeMs = 0;

  // --- saving ---

  /**
   * Player edits, kept as a difference against the generated world.
   *
   * Attached before streaming starts, so that every column that arrives can be
   * patched the moment generation finishes and before anything — lighting,
   * meshing, the indirect-light bake — has read it.
   */
  private save: WorldSave | null = null;
  private saveTimer = 0;

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

      // One more thread, outside the pool, for the indirect-light bake. It is
      // idle almost all the time: a bake happens when the player has walked a
      // grid cell or a couple of seconds have passed, not every frame.
      this.giWorker = new Worker(new URL('./giWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.giWorker.onmessage = (event: MessageEvent<GiResponse>) => {
        this.giInflight = false;
        this.giBakeMs = event.data.ms;
        this.sink?.uploadGiVolume(event.data.result);
      };
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
      giBakeMs: this.giBakeMs,
      savedEdits: this.savedEdits,
    };
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.giWorker?.terminate();
    this.giWorker = null;
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
   * Keeps the indirect-light grid up to date. Call once per frame.
   *
   * A bake is triggered by the player crossing a cell boundary — the grid is
   * toroidal, so a step of four blocks invalidates one slab of it — or by a
   * timer, which is what picks up light that changed for some other reason: a
   * block placed nearby, or a chunk that finished loading inside the grid.
   */
  updateIndirectLight(cameraX: number, cameraZ: number, dt: number): void {
    if (!this.giEnabled || !this.giWorker || this.giInflight) return;

    // The player stands in the middle of the grid.
    const originX = Math.floor(Math.floor(cameraX) / GI_CELL) - GI_SIZE_XZ / 2;
    const originZ = Math.floor(Math.floor(cameraZ) / GI_CELL) - GI_SIZE_XZ / 2;

    this.giTimer -= dt;
    if (originX === this.giOriginX && originZ === this.giOriginZ && this.giTimer > 0) return;

    this.giTimer = 2.5;
    this.giOriginX = originX;
    this.giOriginZ = originZ;
    this.giInflight = true;
    this.giWorker.postMessage({
      type: 'build', id: this.giJobId++, originCellX: originX, originCellZ: originZ,
    } satisfies GiRequest);
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
    const streaming = this.uploadQueue.length > 48;
    const deadline = performance.now() + (streaming ? 7 : 2.5);

    // The time check alone always overshoots by one upload, because it can only
    // notice after the upload has been paid for — and on the "pretty" profile a
    // single section can be a megabyte, which is a visible stall on its own.
    // So the size is checked *before* committing to it: a section is uploaded
    // only if it still fits, or if nothing has gone through yet.
    let budget = streaming ? 3 << 20 : 768 << 10;
    let uploaded = 0;

    while (this.uploadQueue.length > 0) {
      const result = this.uploadQueue[0];

      // A column unloaded while its mesh was in flight has nothing to attach to.
      const state = this.states.get(chunkKey(result.chunkX, result.chunkZ));
      if (!state) {
        this.uploadQueue.shift();
        continue;
      }

      let bytes = 0;
      for (const bucket of result.buckets) {
        if (bucket) bytes += bucket.vertices.byteLength;
      }

      // Always let at least one through, so a heavy section cannot stall the
      // queue forever behind its own cost.
      if (uploaded > 0 && bytes > budget) break;

      this.uploadQueue.shift();
      this.sink.uploadSection(result);
      uploaded++;
      budget -= bytes;

      if (budget <= 0 || performance.now() >= deadline) break;
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
            lodStep: 1,
          });
          newHandles.push(handleOf(column));
          this.queueDirty = true;
          // The state was created with a placeholder level; `rebuildQueue`
          // assigns the real one on the next pass.
        }
      }
    }

    if (newHandles.length > 0 && this.usingWorkers) {
      const message: WorkerRequest = { type: 'register', columns: newHandles };
      for (const worker of this.workers) worker.postMessage(message);
      this.giWorker?.postMessage({ type: 'register', columns: newHandles } satisfies GiRequest);
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
        this.giWorker?.postMessage({ type: 'unregister', columns: removed } satisfies GiRequest);
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
          kind: 'generate', cx: column.x, cz: column.z, sectionY: 0,
          priority: state.priority, step: 1,
        });
        continue;
      }

      if (state.stage === Stage.Generated && this.neighbourhoodAtLeast(column.x, column.z, Stage.Generated)) {
        this.jobQueue.push({
          kind: 'light', cx: column.x, cz: column.z, sectionY: 0,
          priority: state.priority, step: 1,
        });
        continue;
      }

      if (state.stage !== Stage.Lit) continue;
      if (Math.max(Math.abs(dx), Math.abs(dz)) > meshRadius) continue;
      if (!this.neighbourhoodAtLeast(column.x, column.z, Stage.Lit)) continue;

      // A change of detail level invalidates every section of the column.
      const desired = this.lodStepFor(Math.sqrt(state.priority), state.lodStep);
      if (desired !== state.lodStep) {
        state.lodStep = desired;
        state.dirtySections = (1 << SECTION_COUNT) - 1;
      }

      const todo = state.dirtySections & ~state.pendingSections;
      if (todo === 0) continue;

      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if ((todo & (1 << sy)) === 0) continue;
        this.jobQueue.push({
          kind: 'mesh', cx: column.x, cz: column.z, sectionY: sy,
          priority: state.priority, step: state.lodStep,
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
        ? { type: 'mesh', id, cx: job.cx, cz: job.cz, sectionY: job.sectionY, step: job.step }
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
    if (column) {
      column.generated = true;
      this.applySavedEdits(column);
    }
    state.stage = ok || column?.generated ? Stage.Generated : Stage.Empty;
    this.queueDirty = true;
  }

  /**
   * Replays the player's edits onto a freshly generated column.
   *
   * Runs between generation and lighting, which is the only window where it is
   * both possible and free: the terrain exists, and nothing has read it yet, so
   * the light and the mesh come out right the first time instead of needing to
   * be thrown away and rebuilt.
   */
  private applySavedEdits(column: ColumnData): void {
    const edits = this.save?.get(column.x, column.z);
    if (!edits || edits.size === 0) return;

    const touched = new Set<number>();
    for (const [index, block] of edits) {
      column.blocks[index] = block;
      // The column index packs y, z and x; the heightmap only cares about the
      // horizontal part.
      touched.add(index & 0x3ff);
    }
    for (const area of touched) {
      this.refreshHeightmaps(column, area & CHUNK_MASK, area >> 5);
    }
  }

  /** Attaches the save store. Call before any column has been generated. */
  attachSave(save: WorldSave): void {
    this.save = save;
  }

  /**
   * Writes pending edits, at most once every few seconds.
   *
   * Called every frame; the interval is what keeps a burst of building from
   * turning into a burst of transactions.
   */
  updateSave(dt: number): void {
    if (!this.save || this.save.dirtyColumns === 0) return;
    this.saveTimer -= dt;
    if (this.saveTimer > 0) return;
    this.saveTimer = 4;
    void this.save.flush();
  }

  /** Where the player left off, or null for a world never visited. */
  get savedState(): SavedState | null {
    return this.save?.state ?? null;
  }

  /** Remembers the player's position; written out with the next flush. */
  recordPlayerState(state: SavedState): void {
    this.save?.recordState(state);
  }

  /** Writes immediately, for the page going away. */
  flushSave(): Promise<void> {
    return this.save?.flush() ?? Promise.resolve();
  }

  get savedEdits(): number {
    return this.save?.totalEdits ?? 0;
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

    // A result built at a level the column has since moved away from is stale.
    // Its geometry is still valid to show — better than a hole — but the
    // section must stay dirty so the correct level replaces it.
    if (!result || result.step === state.lodStep) {
      state.dirtySections &= ~(1 << sectionY);
    }

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
        const result = pipeline.mesh(
          this.store, job.cx, job.cz, job.sectionY, job.step,
        );
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

    const index = columnIndex(lx, y, lz);
    column.blocks[index] = block;
    this.save?.record(cx, cz, index, block);
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
    // An edit changes what bounces light. Not immediately — the relight has to
    // land first — but soon enough that walling yourself in goes dark.
    this.giTimer = Math.min(this.giTimer, 0.4);
    this.fluids.schedule(x, y, z);
    this.onBlockChanged?.(x, y, z, previous, block);
    return true;
  }

  /**
   * Called after every edit, whoever made it.
   *
   * The hook the game side hangs its reactions on: sand that has to notice the
   * ground left from under it, leaves that have to notice their tree is gone.
   * A callback rather than a list of subscribers because there is exactly one
   * consumer and it is the game layer, which is allowed to know about the
   * world while the world stays ignorant of it.
   */
  onBlockChanged: ((
    x: number, y: number, z: number, previous: number, block: number,
  ) => void) | null = null;

  // -------------------------------------------------------------------------
  // Fluids
  // -------------------------------------------------------------------------

  readonly fluids = new FluidSim(this);

  /** Columns a fluid tick has written to, relit once when the tick ends. */
  private readonly fluidTouched = new Set<number>();

  /**
   * A fluid's write path.
   *
   * Identical to `setBlock` except that it does not relight. A flow front can
   * change two hundred cells in a tick and `setBlock` relights the whole column
   * for each one — a hundred full-column light floods per tick, which is orders
   * of magnitude more work than the meshing it was meant to support. The
   * relights are collected here and done once per column in
   * `flushFluidBlocks`, which is both correct and bounded.
   *
   * It also does not schedule the neighbours: the simulation owns its own
   * queue and knows better than this function which cells its change reaches.
   */
  setFluidBlock(x: number, y: number, z: number, block: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 5;
    const cz = z >> 5;
    const column = this.store.get(cx, cz);
    const state = this.states.get(chunkKey(cx, cz));
    // `Generated` is enough, unlike `setBlock`, and the difference is not a
    // detail: a block edit drops its column back to `Generated` for the
    // relight, and requiring `Lit` here meant every fluid write in the seconds
    // after an edit failed — that is, exactly the writes the edit caused.
    if (!column || !state || state.stage < Stage.Generated) return false;

    const lx = x & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    const index = columnIndex(lx, y, lz);
    const previous = column.blocks[index];
    if (previous === block) return false;

    column.blocks[index] = block;
    this.save?.record(cx, cz, index, block);
    this.refreshHeightmaps(column, lx, lz);
    this.markSectionsDirtyAround(x, y, z);

    this.fluidTouched.add(chunkKey(cx, cz));
    // A cell on a chunk border changes what the neighbour's light skirt sees.
    if (lx === 0) this.fluidTouched.add(chunkKey(cx - 1, cz));
    if (lx === CHUNK_MASK) this.fluidTouched.add(chunkKey(cx + 1, cz));
    if (lz === 0) this.fluidTouched.add(chunkKey(cx, cz - 1));
    if (lz === CHUNK_MASK) this.fluidTouched.add(chunkKey(cx, cz + 1));
    // Same notification as `setBlock`: water washing the ground out from under
    // a sand shelf has to make it fall, and a script that builds with `fill`
    // has to behave like a player who built the same thing by hand.
    this.onBlockChanged?.(x, y, z, previous, block);
    return true;
  }

  /**
   * Writes a box of blocks in one go.
   *
   * `setBlock` is the wrong tool for more than a handful of cells: it relights
   * the whole column for each one, and because a relight drops the column out
   * of `Lit`, the *next* call is refused until it finishes. Building anything
   * from a script therefore turned into a retry loop pacing itself at one block
   * per few hundred milliseconds.
   *
   * This shares the fluid path — write, mark sections dirty, relight once at
   * the end — which is the same batching problem with the same answer. Returns
   * how many cells actually changed.
   */
  fillBlocks(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    block: number,
  ): number {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.max(0, Math.min(y0, y1));
    const maxY = Math.min(WORLD_HEIGHT - 1, Math.max(y0, y1));
    const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);

    let changed = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (this.setFluidBlock(x, y, z, block)) {
            changed++;
            this.fluids.schedule(x, y, z);
          }
        }
      }
    }
    if (changed > 0) this.flushFluidBlocks();
    return changed;
  }

  /** Whether this cell's column exists at all, loaded or still generating. */
  hasColumnAt(x: number, z: number): boolean {
    return this.states.has(chunkKey(x >> 5, z >> 5));
  }

  flushFluidBlocks(): void {
    if (this.fluidTouched.size === 0) return;
    for (const key of this.fluidTouched) {
      const state = this.states.get(key);
      if (!state || state.stage !== Stage.Lit) continue;
      const column = this.store.get(keyToChunkX(key), keyToChunkZ(key));
      if (column) column.lit = false;
      state.stage = Stage.Generated;
    }
    this.fluidTouched.clear();
    this.queueDirty = true;
    this.giTimer = Math.min(this.giTimer, 0.8);
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
  /**
   * Hands new columns' tint tiles to the renderer, a few per frame.
   *
   * This used to upload every ready column in one go, which on a wide render
   * distance means dozens of columns landing together, four `texSubImage3D`
   * calls each. That is the same mistake the mesh queue already learned from
   * (6.7): a burst of synchronous uploads is a visible hitch, and the fix is
   * the same — a budget, so the world fills in over a few frames instead of
   * stopping one.
   */
  refreshAtlases(): void {
    let budget = 4;
    for (const [key, state] of this.states) {
      if (state.atlasUploaded || state.stage < Stage.Lit) continue;
      const column = this.store.getByKey(key);
      if (!column) continue;
      this.uploadAtlas(column);
      state.atlasUploaded = true;
      if (--budget <= 0) break;
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
      const fluid = (BLOCK_FLAGS[block] & BlockFlag.Fluid) !== 0;

      // Stops at anything that is not air and not a fluid.
      //
      // It used to stop only at blocks that also stopped the *player*, which
      // quietly made every walk-through block impossible to aim at: a flower,
      // a fern, a torch. The ray went straight through to the ground behind
      // them, so a torch could be placed and never picked up again. Fluids
      // stay transparent to it unless asked for, because a player looking
      // across a lake is pointing at the far shore.
      if (block !== Block.Air && (!fluid || includeFluids)) {
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

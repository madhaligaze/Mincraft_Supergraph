/**
 * The three stages every chunk goes through, as plain functions over a
 * `ColumnStore`.
 *
 * Written once and used from two places: inside a worker when SharedArrayBuffer
 * is available, and directly on the main thread (time-sliced) when it is not.
 * Keeping the stages free of any transport concern is what makes that possible.
 */

import { TerrainGenerator } from './generator.ts';
import { LightSolver } from './lighting.ts';
import { Mesher, type SectionMeshResult } from './mesher.ts';
import { SECTION_COUNT } from './constants.ts';
import type { ColumnStore } from './storage.ts';

export class ChunkPipeline {
  readonly generator: TerrainGenerator;
  private readonly lightSolver = new LightSolver();
  private readonly mesher = new Mesher();

  constructor(seed: number) {
    this.generator = new TerrainGenerator(seed);
  }

  /** Terrain, ores and vegetation. Needs no neighbours. */
  generate(store: ColumnStore, cx: number, cz: number): boolean {
    const column = store.get(cx, cz);
    if (!column || column.generated) return false;
    this.generator.generate(cx, cz, column);
    column.generated = true;
    return true;
  }

  /** Light flood fill. Requires the 3x3 neighbourhood to be generated. */
  light(store: ColumnStore, cx: number, cz: number): boolean {
    const column = store.get(cx, cz);
    if (!column || !column.generated) return false;
    if (!store.hasNeighbourhood(cx, cz)) return false;
    this.lightSolver.solve(store, cx, cz);
    return true;
  }

  /** Meshes one section. Requires the column to be lit. */
  mesh(store: ColumnStore, cx: number, cz: number, sectionY: number): SectionMeshResult | null {
    const column = store.get(cx, cz);
    if (!column || !column.lit) return null;
    if (sectionY < 0 || sectionY >= SECTION_COUNT) return null;
    return this.mesher.mesh(store, cx, cz, sectionY);
  }
}

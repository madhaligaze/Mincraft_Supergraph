/**
 * Indirect-light worker.
 *
 * Deliberately not part of the chunk pool. A bake reads the whole
 * neighbourhood at once rather than one column, takes about as long as a dozen
 * chunk meshes, and happens on its own schedule — putting it in the pool would
 * mean a mesh job waiting behind it every time the player walks four blocks.
 *
 * Like the chunk workers it holds views over the same SharedArrayBuffers the
 * main thread allocated, so a bake sends nothing but its result back.
 */

import { GiBuilder, type GiResult } from './gi.ts';
import { ColumnData, ColumnStore, type ColumnHandle } from './storage.ts';

export type GiRequest =
  | { type: 'register'; columns: ColumnHandle[] }
  | { type: 'unregister'; columns: Array<{ x: number; z: number }> }
  | { type: 'build'; id: number; originCellX: number; originCellZ: number };

export type GiResponse = {
  type: 'baked';
  id: number;
  result: GiResult;
  /** Milliseconds the bake took, for the stats overlay. */
  ms: number;
};

const store = new ColumnStore();
const builder = new GiBuilder();

self.onmessage = (event: MessageEvent<GiRequest>): void => {
  const message = event.data;

  switch (message.type) {
    case 'register': {
      for (const handle of message.columns) {
        if (store.has(handle.x, handle.z)) continue;
        store.add(new ColumnData(handle.x, handle.z, handle.buffer));
      }
      break;
    }

    case 'unregister': {
      for (const { x, z } of message.columns) store.remove(x, z);
      break;
    }

    case 'build': {
      const started = performance.now();
      const result = builder.build(store, message.originCellX, message.originCellZ);
      (self as unknown as Worker).postMessage(
        { type: 'baked', id: message.id, result, ms: performance.now() - started } satisfies GiResponse,
        [result.data.buffer],
      );
      break;
    }

    default:
      break;
  }
};

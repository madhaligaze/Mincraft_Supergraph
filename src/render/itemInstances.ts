/**
 * Turns dropped items into the instance stream the item pass draws.
 *
 * The bridge between the game side, which knows what an item is, and the
 * renderer, which only knows how to draw twelve floats. It lives here rather
 * than in the entity list because it is the only part that needs to know about
 * texture layers and baked light.
 */

import { BLOCK_FACE_TEX, FACE_PX, FACE_PY } from '../world/blocks.ts';
import { itemDef } from '../game/items.ts';
import type { ItemEntity } from '../game/entities.ts';
import type { World } from '../world/world.ts';
import type { IconSet } from '../ui/icons.ts';
import { ITEM_INSTANCE_FLOATS } from './renderer.ts';

/** Edge length of a dropped block, in blocks. A quarter reads as "an item". */
const ITEM_SCALE = 0.26;
/** Radians a second. Slow enough to read as a hint, not a spinner. */
const SPIN_RATE = 1.3;
const BOB_HEIGHT = 0.055;

export interface ItemInstanceResult {
  cubes: number;
  sprites: number;
}

/**
 * Fills `out` with cube instances first, then sprite instances.
 *
 * Two groups in one buffer because they are two draws sharing one program, and
 * the sprite draw simply starts at an offset — see `renderItems`.
 */
export function buildItemInstances(
  entities: readonly ItemEntity[],
  world: World,
  icons: IconSet,
  out: Float32Array,
): ItemInstanceResult {
  const capacity = Math.floor(out.length / ITEM_INSTANCE_FLOATS);
  let cubes = 0;
  const sprites: ItemEntity[] = [];

  for (const entity of entities) {
    const def = itemDef(entity.item.id);
    if (def.shape !== 'block') {
      sprites.push(entity);
      continue;
    }
    if (cubes >= capacity) break;
    writeInstance(out, cubes * ITEM_INSTANCE_FLOATS, entity, world, def.block, -1);
    cubes++;
  }

  let written = cubes;
  for (const entity of sprites) {
    if (written >= capacity) break;
    const layer = icons.layer[entity.item.id];
    if (layer < 0) continue;
    writeInstance(out, written * ITEM_INSTANCE_FLOATS, entity, world, -1, layer);
    written++;
  }

  return { cubes, sprites: written - cubes };
}

function writeInstance(
  out: Float32Array, offset: number, entity: ItemEntity, world: World,
  block: number, iconLayer: number,
): void {
  const bob = Math.sin(entity.age * 2.1 + entity.x * 1.7 + entity.z) * BOB_HEIGHT;
  const centreY = entity.y + ITEM_SCALE * 0.5 + bob;

  // Light where the item is, not where it fell from: an item kicked into a cave
  // mouth has to go dark as it rolls in.
  const light = world.store.getLight(
    Math.floor(entity.x), Math.floor(centreY), Math.floor(entity.z),
  );

  out[offset] = entity.x;
  out[offset + 1] = centreY;
  out[offset + 2] = entity.z;
  out[offset + 3] = entity.age * SPIN_RATE;

  // The tint stays white in both cases: a block carries its colour in its
  // texture and an icon carries it in its own pixels, so tinting either would
  // be applying the colour twice.
  out[offset + 4] = 1;
  out[offset + 5] = 1;
  out[offset + 6] = 1;

  if (block >= 0) {
    out[offset + 8] = BLOCK_FACE_TEX[block * 6 + FACE_PX];
    out[offset + 9] = BLOCK_FACE_TEX[block * 6 + FACE_PY];
  } else {
    out[offset + 8] = -1;
    out[offset + 9] = iconLayer;
  }

  out[offset + 7] = ITEM_SCALE;
  out[offset + 10] = (light >> 4) / 15;
  out[offset + 11] = (light & 15) / 15;
}

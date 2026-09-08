/**
 * The item in the player's hand.
 *
 * Not a model and not an arm — the block or icon itself, held out at the bottom
 * right of the view, tilted, bobbing with the walk and dipping on every swing.
 * That dip is the point: mining without it is a progress bar, and the reference
 * spends half its tactile feel on the fact that your hand moves when you hit
 * something.
 *
 * It is one instance in the same format the dropped items use, so it costs one
 * draw call and no new shader.
 */

import { BLOCK_FACE_TEX, FACE_PX, FACE_PY } from '../world/blocks.ts';
import { itemDef, type ItemStack } from '../game/items.ts';
import type { World } from '../world/world.ts';
import type { IconSet } from '../ui/icons.ts';
import type { PlayerCamera } from '../player/player.ts';
import { ITEM_INSTANCE_FLOATS } from './renderer.ts';

/**
 * Where the hand sits, in camera space: right, down, forward.
 *
 * Half a block out is as far as it can go: the player's own box keeps the
 * camera about a third of a block from any wall, and a hand held further than
 * that pokes through the wall the player is standing against.
 *
 * The sizes are chosen against the frame rather than against the world — a
 * quarter-block cube at half a block from the eye covers a third of the screen,
 * which is a wall, not a hand.
 */
const HAND_RIGHT = 0.24;
const HAND_DOWN = 0.20;
const HAND_FORWARD = 0.50;

const CUBE_SCALE = 0.16;
const SPRITE_SCALE = 0.22;

/** Resting angles. A block held square-on to the camera reads as a wall. */
const REST_SPIN = 0.7;
const REST_PITCH = 0.35;

export interface HeldItemResult {
  /** True when the instance is a flat icon rather than a textured cube. */
  sprite: boolean;
}

/**
 * Writes the single instance for the held item.
 *
 * `swing` is 0..1 through one swing; `bob` is the walk cycle's phase and
 * amount, taken from the same numbers that move the camera, so hand and view
 * agree.
 */
export function buildHeldItem(
  out: Float32Array,
  item: ItemStack,
  camera: PlayerCamera,
  world: World,
  icons: IconSet,
  swing: number,
  bobPhase: number,
  bobAmount: number,
): HeldItemResult {
  const def = itemDef(item.id);
  const sprite = def.shape !== 'block';

  // The swing: out and down, then back. `sin(pi * t)` peaks in the middle,
  // which is where a swing's lowest point is.
  const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, swing)));
  const drop = arc * 0.16;
  const push = arc * 0.07;

  const bobX = Math.cos(bobPhase) * 0.022 * bobAmount;
  const bobY = Math.sin(bobPhase * 2) * 0.018 * bobAmount;

  // A right vector that ignores pitch, so looking up does not roll the hand
  // out of frame.
  const rx = camera.right[0];
  const rz = camera.right[2];
  const ux = camera.up[0];
  const uy = camera.up[1];
  const uz = camera.up[2];
  const fx = camera.forward[0];
  const fy = camera.forward[1];
  const fz = camera.forward[2];

  const right = HAND_RIGHT + bobX;
  const down = -(HAND_DOWN + drop - bobY);
  const forward = HAND_FORWARD - push;

  const x = camera.position[0] + rx * right + ux * down + fx * forward;
  const y = camera.position[1] + uy * down + fy * forward;
  const z = camera.position[2] + rz * right + uz * down + fz * forward;

  // Lit by where the player is standing, not by where the block came from.
  const light = world.store.getLight(
    Math.floor(camera.position[0]),
    Math.floor(camera.position[1]),
    Math.floor(camera.position[2]),
  );

  // The hand turns with the camera, so the spin has to follow the yaw: the
  // instance is in world space and would otherwise face a fixed compass point.
  const yaw = Math.atan2(-fx, -fz);

  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = sprite ? yaw : yaw + REST_SPIN;

  out[4] = 1;
  out[5] = 1;
  out[6] = 1;
  out[7] = sprite ? SPRITE_SCALE : CUBE_SCALE;

  if (sprite) {
    out[8] = -1;
    out[9] = icons.layer[item.id];
  } else {
    const block = def.block;
    out[8] = BLOCK_FACE_TEX[block * 6 + FACE_PX];
    out[9] = BLOCK_FACE_TEX[block * 6 + FACE_PY];
  }

  out[10] = (light >> 4) / 15;
  out[11] = (light & 15) / 15;

  // Tilt: a fixed lean, plus more of it through the swing.
  out[12] = sprite ? 0 : REST_PITCH + arc * 0.5;
  out[13] = sprite ? 0 : -0.25 - arc * 0.35;
  out[14] = 0;
  out[15] = 0;

  return { sprite };
}

/** Size of the buffer this module fills. */
export const HELD_ITEM_FLOATS = ITEM_INSTANCE_FLOATS;

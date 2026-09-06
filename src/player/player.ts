/**
 * Player movement, collision and camera.
 *
 * Collision resolves one axis at a time against the voxel grid, which is both
 * cheap and well-behaved for a world made entirely of unit cubes: sweeping a
 * capsule would be more general and would buy nothing here.
 */

import { Input } from '../core/input.ts';
import { World } from '../world/world.ts';
import { Block, BLOCK_FLAGS, BlockFlag, HOTBAR, isFluid } from '../world/blocks.ts';
import { WORLD_HEIGHT } from '../world/constants.ts';
import {
  Vec3, vec3, v3set, clamp, damp, lerp, DEG2RAD, saturate,
} from '../core/math.ts';

const PLAYER_WIDTH = 0.62;
const PLAYER_HEIGHT = 1.82;
const EYE_HEIGHT = 1.64;
const SNEAK_EYE_HEIGHT = 1.44;

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 7.0;
const SNEAK_SPEED = 1.6;
const SWIM_SPEED = 3.2;
const FLY_SPEED = 12.0;
const FLY_BOOST = 34.0;

const GRAVITY = 26.0;
const JUMP_VELOCITY = 8.6;
const TERMINAL_VELOCITY = 58.0;

const GROUND_ACCELERATION = 42.0;
const AIR_ACCELERATION = 7.0;
const GROUND_FRICTION = 12.0;
const AIR_FRICTION = 0.6;

const REACH = 6.0;

/** Depth over which the water around the camera reaches its darkest, in blocks. */
const SUBMERSION_DEPTH = 20;
/** How long a full breath lasts underwater. */
const BREATH_SECONDS = 22;
/** How long recovering a full breath at the surface takes. */
const BREATH_REFILL_SECONDS = 3.5;
/** How much slower an out-of-breath swimmer is. */
const DROWNING_SPEED = 0.55;

/** What an interaction did to the world, for the caller to react to. */
export interface BlockEvent {
  kind: 'break' | 'place';
  /** The block that was broken, or the one that was placed. */
  block: number;
  x: number;
  y: number;
  z: number;
}

export interface PlayerCamera {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  fov: number;
}

export class Player {
  readonly position = vec3(0, 80, 0);
  readonly velocity = vec3(0, 0, 0);

  yaw = 0;
  pitch = 0;

  onGround = false;
  inFluid = false;
  headUnderwater = false;
  flying = false;
  sprinting = false;
  sneaking = false;

  /**
   * How deep the head is, 0..1 over the first `SUBMERSION_DEPTH` blocks.
   *
   * The renderer uses it to decide how dark the water is around the camera.
   * Depth is the difference between being just under the surface and being
   * twenty blocks down, and without it both look identical.
   */
  submersion = 0;

  /** Remaining breath, 1 full to 0 empty. */
  breath = 1;
  /** True once breath has run out and the player is being pressed to surface. */
  drowning = false;

  hotbarIndex = 0;

  readonly camera: PlayerCamera = {
    position: vec3(),
    forward: vec3(0, 0, -1),
    up: vec3(0, 1, 0),
    right: vec3(1, 0, 0),
    fov: 75,
  };

  /** Smoothed head height, so crouching eases instead of snapping. */
  private eyeHeight = EYE_HEIGHT;
  private bobPhase = 0;
  private bobAmount = 0;
  private fovMultiplier = 1;

  /** Blocks per second of downward speed at the moment of landing. */
  private lastFallSpeed = 0;

  constructor(private readonly world: World, private readonly input: Input) {}

  setPosition(x: number, y: number, z: number): void {
    v3set(this.position, x, y, z);
    v3set(this.velocity, 0, 0, 0);
  }

  get selectedBlock(): Block {
    return HOTBAR[this.hotbarIndex];
  }

  update(dt: number, baseFov: number): void {
    this.handleLook();
    this.handleHotbar();

    if (this.input.wasPressed('KeyF')) this.flying = !this.flying;

    this.sneaking = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');

    this.updateFluidState(dt);
    this.move(dt);
    this.updateCamera(dt, baseFov);
  }

  private handleLook(): void {
    if (!this.input.locked) return;
    this.yaw -= this.input.mouseDX * this.input.sensitivity;
    this.pitch -= this.input.mouseDY * this.input.sensitivity;
    // Just short of straight up/down, so the camera basis never degenerates.
    this.pitch = clamp(this.pitch, -Math.PI * 0.4999, Math.PI * 0.4999);
    this.yaw = this.yaw % (Math.PI * 2);
  }

  private handleHotbar(): void {
    for (let i = 0; i < 9; i++) {
      if (this.input.wasPressed(`Digit${i + 1}`)) this.hotbarIndex = i;
    }
    if (this.input.wheelDelta !== 0) {
      const count = HOTBAR.length;
      this.hotbarIndex = (this.hotbarIndex + this.input.wheelDelta + count) % count;
    }
  }

  private updateFluidState(dt: number): void {
    const feetBlock = this.world.getBlock(
      Math.floor(this.position[0]),
      Math.floor(this.position[1] + 0.2),
      Math.floor(this.position[2]),
    );
    this.inFluid = isFluid(feetBlock);

    const x = Math.floor(this.position[0]);
    const z = Math.floor(this.position[2]);
    const eyeY = Math.floor(this.position[1] + this.eyeHeight);
    this.headUnderwater = this.world.getBlock(x, eyeY, z) === Block.Water;

    if (this.headUnderwater) {
      // Walk up to the surface to find out how deep this is. The scan is
      // capped, so it costs a fixed handful of lookups a frame however deep the
      // ocean gets — and past the cap it is as dark as it is going to get.
      let above = 0;
      while (
        above < SUBMERSION_DEPTH &&
        this.world.getBlock(x, eyeY + above + 1, z) === Block.Water
      ) {
        above++;
      }
      this.submersion = above / SUBMERSION_DEPTH;
      this.breath = Math.max(0, this.breath - dt / BREATH_SECONDS);
    } else {
      this.submersion = 0;
      // Refilling is much faster than draining: surfacing for a moment should
      // be enough to go back down, or the sea becomes somewhere to look at
      // rather than somewhere to swim.
      this.breath = Math.min(1, this.breath + dt / BREATH_REFILL_SECONDS);
    }

    this.drowning = this.breath <= 0;
  }

  private move(dt: number): void {
    const input = this.input;

    // Movement axes from yaw only: looking up must not slow the player down.
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    const forwardX = -sinYaw;
    const forwardZ = -cosYaw;
    const rightX = cosYaw;
    const rightZ = -sinYaw;

    let wishX = 0;
    let wishZ = 0;
    if (input.isDown('KeyW')) { wishX += forwardX; wishZ += forwardZ; }
    if (input.isDown('KeyS')) { wishX -= forwardX; wishZ -= forwardZ; }
    if (input.isDown('KeyD')) { wishX += rightX; wishZ += rightZ; }
    if (input.isDown('KeyA')) { wishX -= rightX; wishZ -= rightZ; }

    const wishLength = Math.hypot(wishX, wishZ);
    if (wishLength > 1e-4) {
      wishX /= wishLength;
      wishZ /= wishLength;
    }

    const moving = wishLength > 1e-4;
    this.sprinting = moving && input.isDown('ControlLeft') && !this.sneaking;

    if (this.flying) {
      this.moveFlying(dt, wishX, wishZ);
      return;
    }

    // Out of breath is slower. There is no health system to take damage from,
    // so the pressure to surface has to be something the player feels in the
    // controls; combined with the vignette closing in, it reads clearly enough
    // to change what the player does.
    const drowningFactor = this.drowning ? DROWNING_SPEED : 1;

    const targetSpeed = (this.inFluid
      ? SWIM_SPEED
      : this.sneaking
        ? SNEAK_SPEED
        : this.sprinting ? SPRINT_SPEED : WALK_SPEED) * drowningFactor;

    const acceleration = this.onGround ? GROUND_ACCELERATION : AIR_ACCELERATION;
    const friction = this.onGround ? GROUND_FRICTION : AIR_FRICTION;

    // Accelerate toward the wish velocity, then apply friction. Splitting the
    // two is what gives the familiar responsive-on-ground, floaty-in-air feel.
    this.velocity[0] += wishX * targetSpeed * acceleration * dt;
    this.velocity[2] += wishZ * targetSpeed * acceleration * dt;

    const horizontalSpeed = Math.hypot(this.velocity[0], this.velocity[2]);
    if (horizontalSpeed > 1e-5) {
      const drop = horizontalSpeed * friction * dt;
      const scale = Math.max(0, horizontalSpeed - drop) / horizontalSpeed;
      this.velocity[0] *= scale;
      this.velocity[2] *= scale;
    }

    const maxSpeed = targetSpeed * (this.inFluid ? 1.0 : 1.05);
    const speedNow = Math.hypot(this.velocity[0], this.velocity[2]);
    if (speedNow > maxSpeed) {
      const scale = maxSpeed / speedNow;
      this.velocity[0] *= scale;
      this.velocity[2] *= scale;
    }

    // Vertical.
    if (this.inFluid) {
      this.velocity[1] -= GRAVITY * 0.28 * dt;
      if (input.isDown('Space')) this.velocity[1] += 22 * drowningFactor * dt;
      this.velocity[1] *= Math.exp(-4.2 * dt);
    } else {
      this.velocity[1] -= GRAVITY * dt;
      if (this.velocity[1] < -TERMINAL_VELOCITY) this.velocity[1] = -TERMINAL_VELOCITY;
      if (input.isDown('Space') && this.onGround) {
        this.velocity[1] = JUMP_VELOCITY;
        this.onGround = false;
      }
    }

    this.applyMotion(dt);
  }

  private moveFlying(dt: number, wishX: number, wishZ: number): void {
    const input = this.input;
    const boost = input.isDown('ControlLeft');
    const speed = boost ? FLY_BOOST : FLY_SPEED;

    // Include pitch when flying: pointing the camera down should descend.
    const pitchCos = Math.cos(this.pitch);
    const forwardY = Math.sin(this.pitch);

    let targetX = wishX * speed * pitchCos;
    let targetZ = wishZ * speed * pitchCos;
    let targetY = 0;

    if (input.isDown('KeyW') || input.isDown('KeyS')) {
      const sign = input.isDown('KeyW') ? 1 : -1;
      targetY += forwardY * speed * sign;
    }
    if (input.isDown('Space')) targetY += speed;
    if (this.sneaking) targetY -= speed;

    const rate = 14;
    this.velocity[0] = damp(this.velocity[0], targetX, rate, dt);
    this.velocity[1] = damp(this.velocity[1], targetY, rate, dt);
    this.velocity[2] = damp(this.velocity[2], targetZ, rate, dt);

    this.applyMotion(dt);
    this.onGround = false;
  }

  /** Integrates velocity with per-axis collision resolution. */
  private applyMotion(dt: number): void {
    // Clamp the step so a long frame cannot tunnel through a wall.
    const step = Math.min(dt, 0.05);
    const dx = this.velocity[0] * step;
    const dy = this.velocity[1] * step;
    const dz = this.velocity[2] * step;

    const wasFalling = this.velocity[1];
    this.onGround = false;

    this.moveAxis(1, dy);
    this.moveAxis(0, dx);
    this.moveAxis(2, dz);

    if (this.onGround && wasFalling < -0.1) this.lastFallSpeed = -wasFalling;

    // Do not fall out of the world while chunks are still streaming in.
    if (this.position[1] < 1) {
      if (!this.world.isReadyAt(Math.floor(this.position[0]), Math.floor(this.position[2]))) {
        this.position[1] = Math.max(this.position[1], 1);
        this.velocity[1] = 0;
      }
    }
  }

  private moveAxis(axis: number, amount: number): void {
    if (amount === 0) return;

    this.position[axis] += amount;

    const half = PLAYER_WIDTH * 0.5;
    const minX = this.position[0] - half;
    const maxX = this.position[0] + half;
    const minY = this.position[1];
    const maxY = this.position[1] + PLAYER_HEIGHT;
    const minZ = this.position[2] - half;
    const maxZ = this.position[2] + half;

    const x0 = Math.floor(minX), x1 = Math.floor(maxX);
    const y0 = Math.floor(minY), y1 = Math.floor(maxY);
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ);

    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= WORLD_HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (!this.world.isSolidAt(x, y, z)) continue;

          // Push out along the axis we just moved on.
          if (axis === 0) {
            this.position[0] = amount > 0 ? x - half - 1e-4 : x + 1 + half + 1e-4;
            this.velocity[0] = 0;
          } else if (axis === 1) {
            if (amount > 0) {
              this.position[1] = y - PLAYER_HEIGHT - 1e-4;
            } else {
              this.position[1] = y + 1 + 1e-4;
              this.onGround = true;
            }
            this.velocity[1] = 0;
          } else {
            this.position[2] = amount > 0 ? z - half - 1e-4 : z + 1 + half + 1e-4;
            this.velocity[2] = 0;
          }
          return;
        }
      }
    }
  }

  private updateCamera(dt: number, baseFov: number): void {
    const camera = this.camera;

    // Head height eases between standing and crouching.
    const targetEye = this.sneaking ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
    this.eyeHeight = damp(this.eyeHeight, targetEye, 14, dt);

    // View bob, driven by actual horizontal speed rather than input, so it
    // stops the moment the player walks into a wall.
    const speed = Math.hypot(this.velocity[0], this.velocity[2]);
    const targetBob = this.onGround && !this.flying ? saturate(speed / WALK_SPEED) : 0;
    this.bobAmount = damp(this.bobAmount, targetBob, 8, dt);
    this.bobPhase += speed * dt * 1.9;

    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.045 * this.bobAmount;
    const bobRoll = Math.cos(this.bobPhase) * 0.011 * this.bobAmount;

    // Sprinting widens the field of view slightly; it reads as speed.
    const targetFov = this.sprinting ? 1.075 : this.flying && this.input.isDown('ControlLeft') ? 1.14 : 1;
    this.fovMultiplier = damp(this.fovMultiplier, targetFov, 7, dt);
    camera.fov = baseFov * this.fovMultiplier;

    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);

    v3set(camera.forward, -sinYaw * cosPitch, sinPitch, -cosYaw * cosPitch);
    v3set(camera.right, cosYaw, 0, -sinYaw);

    // Roll the up vector for the walk bob.
    const upX = camera.right[0] * -bobRoll;
    const upZ = camera.right[2] * -bobRoll;
    v3set(camera.up, upX, 1, upZ);

    v3set(
      camera.position,
      this.position[0] + camera.right[0] * bobX,
      this.position[1] + this.eyeHeight + bobY,
      this.position[2] + camera.right[2] * bobX,
    );
  }

  /** The block the crosshair is on, or null. */
  pick(): ReturnType<World['raycast']> {
    const c = this.camera;
    return this.world.raycast(
      c.position[0], c.position[1], c.position[2],
      c.forward[0], c.forward[1], c.forward[2],
      REACH,
    );
  }

  /** Handles break and place. Returns what happened, for the audio and light. */
  interact(): BlockEvent | null {
    const hit = this.pick();
    if (!hit) return null;

    if (this.input.wasButtonPressed(0)) {
      if (hit.block === Block.Bedrock) return null;
      return this.world.setBlock(hit.x, hit.y, hit.z, Block.Air)
        ? { kind: 'break', block: hit.block, x: hit.x, y: hit.y, z: hit.z }
        : null;
    }

    if (this.input.wasButtonPressed(2)) {
      const x = hit.x + hit.nx;
      const y = hit.y + hit.ny;
      const z = hit.z + hit.nz;

      // Refuse to place a block inside the player.
      const half = PLAYER_WIDTH * 0.5;
      const overlapsPlayer =
        x + 1 > this.position[0] - half && x < this.position[0] + half &&
        y + 1 > this.position[1] && y < this.position[1] + PLAYER_HEIGHT &&
        z + 1 > this.position[2] - half && z < this.position[2] + half;

      const target = this.world.getBlock(x, y, z);
      const replaceable = target === Block.Air ||
        (BLOCK_FLAGS[target] & BlockFlag.Passable) !== 0;

      if (!overlapsPlayer && replaceable) {
        return this.world.setBlock(x, y, z, this.selectedBlock)
          ? { kind: 'place', block: this.selectedBlock, x, y, z }
          : null;
      }
    }

    return null;
  }

  /** Impact speed of the last landing, consumed by the HUD/audio. */
  takeLandingImpact(): number {
    const value = this.lastFallSpeed;
    this.lastFallSpeed = 0;
    return value;
  }

  /** Field-of-view in radians, for the shadow fit. */
  get fovRadians(): number {
    return this.camera.fov * DEG2RAD;
  }

  /** Interpolated eye height, for the HUD readout. */
  get currentEyeHeight(): number {
    return lerp(this.eyeHeight, this.eyeHeight, 1);
  }
}

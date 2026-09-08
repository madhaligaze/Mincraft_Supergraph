/**
 * Player movement, collision and camera.
 *
 * Collision resolves one axis at a time against the voxel grid, which is both
 * cheap and well-behaved for a world made entirely of unit cubes: sweeping a
 * capsule would be more general and would buy nothing here.
 */

import { Input } from '../core/input.ts';
import { World } from '../world/world.ts';
import {
  Block, BLOCK_FLAGS, BlockFlag, HOTBAR_SLOTS, isFluid, isOpaque, isSolid,
} from '../world/blocks.ts';
import { FLUID_LEVEL, FLUID_SOURCE, FLUID_KIND } from '../world/blocks.ts';
import { isLava, isWater } from '../world/fluids.ts';
import type { Inventory } from '../game/inventory.ts';
import {
  Item, blockOfItem, bucketHolds, foodValue, isBucket, stack,
} from '../game/items.ts';
import { breakSeconds } from '../game/mining.ts';
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
/**
 * Chosen so the jump clears exactly one block and not one and a half.
 *
 * `v^2 / 2g` with 8.6 came to 1.42 blocks, and the playthrough measured 1.67 —
 * which is a different game: a player who can step onto a block and a half
 * reads terrain differently, and every ledge the generator makes stops being an
 * obstacle. Minecraft's jump is 1.2522 blocks; `sqrt(2 * 26 * 1.2522)` is 8.07.
 */
const JUMP_VELOCITY = 8.07;
const TERMINAL_VELOCITY = 58.0;

const GROUND_ACCELERATION = 42.0;
const AIR_ACCELERATION = 7.0;
const GROUND_FRICTION = 12.0;
const AIR_FRICTION = 0.6;

const REACH = 6.0;

/** Blocks that answer a right-click themselves instead of being built on. */
const USABLE = new Set<number>([Block.CraftingTable, Block.Furnace, Block.FurnaceLit]);

// --- damage, in half-hearts and the reference's numbers ---

/** Blocks of a fall that cost nothing. */
const FALL_SAFE_BLOCKS = 3;
/** How often the contact sources tick. */
const HURT_INTERVAL = 0.5;
const LAVA_DAMAGE = 4;
/** Per second, once the air runs out. */
const DROWN_DAMAGE = 2;
/** Quiet seconds before healing starts, and seconds per half-heart after. */
const REGEN_DELAY = 5;
const REGEN_INTERVAL = 4;

// --- hunger, in the reference's units: twenty points, four exhaustion each ---

/** Exhaustion needed to spend one hunger point. */
const EXHAUSTION_PER_POINT = 4;
/** Exhaustion per block walked, sprinted, and per jump. */
const EXHAUSTION_WALK = 0.01;
const EXHAUSTION_SPRINT = 0.1;
const EXHAUSTION_JUMP = 0.05;
/** Exhaustion for breaking one block. */
const EXHAUSTION_MINE = 0.005;
/** Below this, the body stops healing. The reference's threshold. */
const REGEN_HUNGER = 18;
/** Seconds between starvation hits once hunger is empty. */
const STARVE_INTERVAL = 4;
/** Seconds of holding the button to finish a meal. */
const EAT_SECONDS = 1.6;

/** Depth over which the water around the camera reaches its darkest, in blocks. */
const SUBMERSION_DEPTH = 20;
/** How long a full breath lasts underwater. */
const BREATH_SECONDS = 22;
/** How long recovering a full breath at the surface takes. */
const BREATH_REFILL_SECONDS = 3.5;
/** How much slower an out-of-breath swimmer is. */
const DROWNING_SPEED = 0.55;

/**
 * Largest slice of time the collision resolver may integrate at once.
 *
 * At walking speed a slice this long moves the player under a quarter of a
 * block, which is far inside the thinnest thing they can collide with.
 */
const MAX_PHYSICS_STEP = 0.05;

/** What an interaction did to the world, for the caller to react to. */
export interface BlockEvent {
  /**
   * `use` is a right-click the block itself answered — a crafting table;
   * `eat` is a meal finishing, and carries no block at all.
   */
  kind: 'break' | 'place' | 'use' | 'eat';
  /** The block that was broken, placed, or used. */
  block: number;
  x: number;
  y: number;
  z: number;
}

/** Where damage came from. The HUD says it, and the death message reads it. */
export type DamageCause =
  'fall' | 'lava' | 'cactus' | 'drown' | 'crush' | 'void' | 'starve';

/** How far along the block under the crosshair is, for the HUD and the shader. */
export interface BreakState {
  x: number;
  y: number;
  z: number;
  block: number;
  /** 0..1. */
  progress: number;
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

  /**
   * Health in half-hearts, as in the reference: twenty is full.
   *
   * Until now the only pressure in the world was running out of air, and even
   * that could only make the player slow — nothing could stop them. A fall from
   * a cliff, a step into lava and a night spent underwater all cost exactly
   * nothing, which is what made building and digging feel weightless.
   */
  readonly maxHealth = 20;
  health = 20;
  dead = false;

  /** Set for one frame when damage lands, for the HUD flash and the sound. */
  lastHurt: { amount: number; cause: DamageCause } | null = null;

  /**
   * Hunger, 0..20, and the exhaustion that spends it.
   *
   * Without it there is no reason to ever go up: a player who has iron tools
   * and a torch can live in a mine for ever. Hunger is the clock that sends
   * them back to the surface, and the reason an apple tree is worth remembering.
   */
  hunger = 20;
  private exhaustion = 0;
  private starveTimer = STARVE_INTERVAL;
  /** Seconds spent holding the eat button, 0 when not eating. */
  eating = 0;

  /** Seconds since the last damage; regeneration waits this out. */
  private sinceDamage = 0;
  /** Accumulators for the sources that tick rather than fire once. */
  private hurtTimer = 0;
  private regenTimer = 0;
  /** Fall speed waiting to be turned into damage, in blocks per second. */
  private pendingFallSpeed = 0;
  private drownTimer = 1;

  /**
   * The block being mined right now, or null.
   *
   * Public because three other systems need it and none of them should have to
   * ask twice: the renderer draws the cracks, the HUD could draw a bar, and the
   * audio wants to keep a digging loop going.
   */
  breaking: BreakState | null = null;

  /** Set while an inventory window is open: the world must not react to clicks. */
  uiOpen = false;

  /**
   * How far through a swing the hand is, 0..1, or 1 when it is at rest.
   *
   * Driven here rather than in the renderer because what starts a swing is a
   * game event — a block broken, a block placed, a pick coming down on stone —
   * and the renderer knows about none of those.
   */
  swing = 1;

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

  /** Seconds one swing takes. Minecraft's is a third of a second. */
  private static readonly SWING_SECONDS = 0.3;

  constructor(
    private readonly world: World,
    private readonly input: Input,
    readonly inventory: Inventory,
  ) {}

  setPosition(x: number, y: number, z: number): void {
    v3set(this.position, x, y, z);
    v3set(this.velocity, 0, 0, 0);
  }

  /** The hotbar slot in hand. Lives on the inventory; mirrored here for the save. */
  get hotbarIndex(): number {
    return this.inventory.selected;
  }

  set hotbarIndex(index: number) {
    this.inventory.selected = clamp(index | 0, 0, HOTBAR_SLOTS - 1);
  }

  /** The block the held item would place, or `Block.Air` for a stick. */
  get selectedBlock(): Block {
    const held = this.inventory.held;
    return held ? blockOfItem(held.id) : Block.Air;
  }

  update(dt: number, baseFov: number): void {
    this.handleLook();
    this.handleHotbar();

    if (this.input.wasPressed('KeyF')) this.flying = !this.flying;

    this.sneaking = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');

    this.updateFluidState(dt);

    // Physics in fixed slices.
    //
    // The step has to be capped or a long frame lets the player pass through a
    // wall — but capping it and throwing the rest away is what the collision
    // resolver used to do, and that turns a frame-rate drop into slow motion:
    // at fifteen frames a second the player walked at three quarters speed, and
    // on the "pretty" profile the target hardware sits right there. Slicing
    // keeps the simulated time equal to the real time whatever the frame rate.
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-5 && guard++ < 8) {
      const step = Math.min(remaining, MAX_PHYSICS_STEP);
      this.move(step);
      remaining -= step;
    }

    this.updateHealth(dt);
    if (this.swing < 1) this.swing = Math.min(1, this.swing + dt / Player.SWING_SECONDS);
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
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (this.input.wasPressed(`Digit${i + 1}`)) this.hotbarIndex = i;
    }
    if (this.input.wheelDelta !== 0) {
      const count = HOTBAR_SLOTS;
      this.hotbarIndex = (this.hotbarIndex + this.input.wheelDelta + count) % count;
    }
  }

  /**
   * Damage, healing and dying.
   *
   * All five sources are the reference's, with its numbers: a fall costs one
   * half-heart per block past the third, lava four every half second, a cactus
   * one, suffocation one, and running out of air two a second. Regeneration
   * stands in for eating — there is no hunger yet, so a player who gets away
   * heals slowly instead of never.
   */
  private updateHealth(dt: number): void {
    // Cleared before the dead check, not after: a corpse that keeps reporting
    // the blow that killed it makes the HUD flash red and the hurt sound fire
    // every frame until the player presses respawn.
    this.lastHurt = null;
    if (this.dead) return;

    // Falling. `pendingFallSpeed` is the speed at the moment of landing, and
    // the height it came from is what the reference charges for: v² / 2g.
    // Water breaks a fall completely, as it does in the reference — which is
    // the only reason jumping off anything is ever a good idea.
    if (this.inFluid) this.pendingFallSpeed = 0;

    if (this.pendingFallSpeed > 0) {
      const distance = (this.pendingFallSpeed * this.pendingFallSpeed) / (2 * GRAVITY);
      this.pendingFallSpeed = 0;
      const damage = Math.floor(distance - FALL_SAFE_BLOCKS);
      if (damage > 0) this.hurt(damage, 'fall');
    }

    this.updateHunger(dt);

    const x = Math.floor(this.position[0]);
    const z = Math.floor(this.position[2]);
    const feetY = Math.floor(this.position[1] + 0.1);
    const eyeY = Math.floor(this.position[1] + this.eyeHeight);

    const feet = this.world.getBlock(x, feetY, z);
    const head = this.world.getBlock(x, eyeY, z);

    // The half-second sources share one clock, so standing in lava inside a
    // cactus does not tick twice as fast as either would alone.
    this.hurtTimer -= dt;
    if (this.hurtTimer <= 0) {
      this.hurtTimer = HURT_INTERVAL;

      const inLava = isLava(feet) || isLava(head);
      const touchingHarmful =
        (BLOCK_FLAGS[feet] & BlockFlag.Harmful) !== 0 ||
        (BLOCK_FLAGS[head] & BlockFlag.Harmful) !== 0;

      if (inLava) this.hurt(LAVA_DAMAGE, 'lava');
      else if (touchingHarmful) this.hurt(1, 'cactus');

      // Suffocation: the head is inside something solid. Only when the player
      // is not flying — a creative pass through a wall is not a death.
      if (!this.flying && isSolid(head) && isOpaque(head)) this.hurt(1, 'crush');
    }

    // Drowning is on its own clock because the reference's rate is per second,
    // and because the breath meter has already told the player it is coming.
    if (this.drowning && this.headUnderwater) {
      this.drownTimer -= dt;
      if (this.drownTimer <= 0) {
        this.drownTimer = 1;
        this.hurt(DROWN_DAMAGE, 'drown');
      }
    } else {
      this.drownTimer = 1;
    }

    this.sinceDamage += dt;
    // Healing runs on food, as in the reference: a starving player does not
    // recover, which is what makes hunger a threat rather than a chore.
    if (this.health < this.maxHealth && this.sinceDamage > REGEN_DELAY &&
        this.hunger >= REGEN_HUNGER) {
      this.regenTimer -= dt;
      if (this.regenTimer <= 0) {
        this.regenTimer = REGEN_INTERVAL;
        this.health = Math.min(this.maxHealth, this.health + 1);
      }
    } else {
      this.regenTimer = REGEN_INTERVAL;
    }
  }

  /**
   * Spends hunger on effort, and starves the player when there is none left.
   *
   * Exhaustion is the reference's mechanism: everything the player does adds a
   * little, and every four of it costs a hunger point. It means sprinting
   * across a continent costs food and standing still does not.
   */
  private updateHunger(dt: number): void {
    if (this.exhaustion >= EXHAUSTION_PER_POINT) {
      const points = Math.floor(this.exhaustion / EXHAUSTION_PER_POINT);
      this.exhaustion -= points * EXHAUSTION_PER_POINT;
      this.hunger = Math.max(0, this.hunger - points);
    }

    if (this.hunger > 0) {
      this.starveTimer = STARVE_INTERVAL;
      return;
    }

    // Starvation stops at half a heart rather than killing outright: dying of
    // hunger while asleep in a mine is a way to lose a session, not a lesson.
    this.starveTimer -= dt;
    if (this.starveTimer <= 0) {
      this.starveTimer = STARVE_INTERVAL;
      if (this.health > 1) this.hurt(1, 'starve');
    }
  }

  /** Adds effort. Public because mining and jumping happen elsewhere. */
  addExhaustion(amount: number): void {
    this.exhaustion += amount;
  }

  /** Applies damage. Public so lava-splash and future mobs can call it. */
  hurt(amount: number, cause: DamageCause): void {
    if (this.dead || amount <= 0) return;

    // Armour: four percent off per point, capped at twenty points, and every
    // worn piece takes a hit. Drowning goes straight through it — armour does
    // not help you breathe, and in the reference it does not.
    if (cause !== 'drown') {
      const defense = Math.min(20, this.inventory.defense);
      if (defense > 0) {
        amount = Math.max(1, Math.round(amount * (1 - defense * 0.04)));
        this.inventory.damageArmour(1);
      }
    }

    this.health = Math.max(0, this.health - amount);
    this.sinceDamage = 0;
    this.lastHurt = { amount, cause };
    if (this.health <= 0) this.dead = true;
  }

  /** Back on your feet with a full bar. The caller decides where. */
  revive(): void {
    this.health = this.maxHealth;
    this.hunger = 20;
    this.exhaustion = 0;
    this.eating = 0;
    this.dead = false;
    this.breath = 1;
    this.drowning = false;
    this.sinceDamage = 0;
    this.hurtTimer = HURT_INTERVAL;
    this.pendingFallSpeed = 0;
    this.lastFallSpeed = 0;
    v3set(this.velocity, 0, 0, 0);
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
    this.headUnderwater = isWater(this.world.getBlock(x, eyeY, z));

    if (this.headUnderwater) {
      // Walk up to the surface to find out how deep this is. The scan is
      // capped, so it costs a fixed handful of lookups a frame however deep the
      // ocean gets — and past the cap it is as dark as it is going to get.
      let above = 0;
      while (
        above < SUBMERSION_DEPTH &&
        isWater(this.world.getBlock(x, eyeY + above + 1, z))
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

    // Vertical. Nothing falls through a world that has not arrived: while the
    // column underfoot is still streaming, `isSolidAt` says "no" for terrain
    // that is merely absent, and gravity would bury the player in it the
    // moment it lands.
    if (!this.groundLoaded()) {
      this.velocity[1] = 0;
      this.applyMotion(dt);
      return;
    }

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
        this.exhaustion += EXHAUSTION_JUMP;
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

  /**
   * Integrates velocity with per-axis collision resolution.
   *
   * `dt` is already one physics slice — see the loop in `update`. It used to
   * clamp here instead, which silently dropped the remainder of a long frame.
   */
  private applyMotion(dt: number): void {
    const dx = this.velocity[0] * dt;
    const dy = this.velocity[1] * dt;
    const dz = this.velocity[2] * dt;
    const beforeX = this.position[0];
    const beforeZ = this.position[2];

    const wasFalling = this.velocity[1];
    this.onGround = false;

    this.moveAxis(1, dy);
    this.moveAxis(0, dx);
    this.moveAxis(2, dz);

    // Effort is charged for distance actually covered, not for input: walking
    // into a wall is not exercise.
    if (this.onGround && !this.flying) {
      const moved = Math.hypot(this.position[0] - beforeX, this.position[2] - beforeZ);
      this.exhaustion += moved * (this.sprinting ? EXHAUSTION_SPRINT : EXHAUSTION_WALK);
    }

    // The **largest** impact since the last read, not the latest.
    //
    // A frame is integrated in slices of at most 50 ms, and every slice after
    // the one that landed also "lands": gravity pulls the player a hair into
    // the floor and the resolver pushes them back out at a speed of about one
    // block a second. Overwriting meant a twelve-block drop was recorded as
    // that last hair — which read as "fall damage does not work" while the
    // landing sound was quietly wrong too.
    if (this.onGround && wasFalling < -0.1) {
      const speed = -wasFalling;
      if (speed > this.lastFallSpeed) this.lastFallSpeed = speed;
      // Kept apart from `lastFallSpeed`, which the audio consumes: two readers
      // of one value means whichever runs first silently eats the other's.
      if (speed > this.pendingFallSpeed) this.pendingFallSpeed = speed;
    }

    // Do not fall out of the world while chunks are still streaming in.
    if (this.position[1] < 1) {
      if (!this.world.isReadyAt(Math.floor(this.position[0]), Math.floor(this.position[2]))) {
        this.position[1] = Math.max(this.position[1], 1);
        this.velocity[1] = 0;
      }
    }
  }

  /**
   * Is there ground to stand on, or is the column still on its way?
   *
   * `isSolidAt` answers "no" for a column that has not arrived, which is the
   * same answer it gives for open air — so a player standing on terrain that
   * gets unloaded for a moment falls, and when the column comes back they are
   * inside it. That is how the playthrough kept reporting a jump of exactly
   * zero blocks with the player's feet in dirt and their head in a grass
   * block: not a jump bug, a fall through a world that was not there yet.
   */
  private groundLoaded(): boolean {
    return this.world.isReadyAt(
      Math.floor(this.position[0]), Math.floor(this.position[2]),
    );
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

  /**
   * Mining, placing and using. Returns what happened, for audio, light and drops.
   *
   * Mining is a **held** action now, not a click: progress accumulates while the
   * button is down and the crosshair stays on the same block, and resets the
   * moment either changes. That reset is the part that makes it feel right —
   * glancing away mid-swing has to cost the swing, or the timer stops being
   * something the player is doing and becomes something happening to them.
   */
  interact(dt: number): BlockEvent | null {
    if (this.uiOpen || this.dead) {
      this.breaking = null;
      return null;
    }

    // Eating comes before everything else the right button does: a held apple
    // is not a block, so nothing else would happen anyway, and checking it
    // first keeps the "hold to eat" timer out of the placement path.
    const held = this.inventory.held;
    const food = held ? foodValue(held.id) : 0;
    if (food > 0 && this.hunger < 20 && this.input.isButtonDown(2)) {
      this.eating += dt;
      if (this.eating >= EAT_SECONDS) {
        this.eating = 0;
        this.hunger = Math.min(20, this.hunger + food);
        this.inventory.consumeHeld(1);
        return { kind: 'eat', block: Block.Air, x: 0, y: 0, z: 0 };
      }
      this.breaking = null;
      return null;
    }
    this.eating = 0;

    // The bucket needs its own ray, because the ordinary one is blind to
    // fluids on purpose: a player looking across a lake is pointing at the far
    // shore, not at the water.
    if (held && isBucket(held.id) && this.input.wasButtonPressed(2)) {
      const event = this.useBucket(held.id);
      if (event) return event;
    }

    const hit = this.pick();

    if (this.input.isButtonDown(0) && hit) {
      const current = this.breaking;
      if (!current || current.x !== hit.x || current.y !== hit.y ||
          current.z !== hit.z || current.block !== hit.block) {
        this.breaking = { x: hit.x, y: hit.y, z: hit.z, block: hit.block, progress: 0 };
      }

      const state = this.breaking!;
      const seconds = breakSeconds(hit.block, this.inventory.held);
      if (!Number.isFinite(seconds)) {
        // Bedrock and fluids: keep the crosshair on it, never make progress.
        state.progress = 0;
      } else if (seconds <= 0) {
        state.progress = 1;
      } else {
        state.progress += dt / seconds;
      }

      // A swing per hit, restarted as each one finishes: mining is a hand
      // coming down over and over, and one swing at the end of a seven-second
      // dig reads as the block giving up on its own.
      this.startSwing();

      if (state.progress >= 1) {
        this.breaking = null;
        this.exhaustion += EXHAUSTION_MINE;
        return this.world.setBlock(hit.x, hit.y, hit.z, Block.Air)
          ? { kind: 'break', block: hit.block, x: hit.x, y: hit.y, z: hit.z }
          : null;
      }
    } else {
      this.breaking = null;
    }

    if (this.input.wasButtonPressed(2) && hit) {
      // The block gets the click first. Sneaking overrides that, which is how a
      // player puts a block down on top of a crafting table.
      if (!this.sneaking && USABLE.has(hit.block)) {
        return { kind: 'use', block: hit.block, x: hit.x, y: hit.y, z: hit.z };
      }

      const placing = this.selectedBlock;
      if (placing === Block.Air) return null;

      // Aiming at grass or a flower replaces it, rather than building on top
      // of it: the crosshair is on something the world treats as scenery, and
      // in the reference a placed block simply takes its cell.
      const aimedAtScenery =
        (BLOCK_FLAGS[hit.block] & BlockFlag.Passable) !== 0 &&
        (BLOCK_FLAGS[hit.block] & BlockFlag.Fluid) === 0;

      const x = aimedAtScenery ? hit.x : hit.x + hit.nx;
      const y = aimedAtScenery ? hit.y : hit.y + hit.ny;
      const z = aimedAtScenery ? hit.z : hit.z + hit.nz;

      // Refuse to place a block inside the player.
      const half = PLAYER_WIDTH * 0.5;
      const overlapsPlayer =
        x + 1 > this.position[0] - half && x < this.position[0] + half &&
        y + 1 > this.position[1] && y < this.position[1] + PLAYER_HEIGHT &&
        z + 1 > this.position[2] - half && z < this.position[2] + half;

      const target = this.world.getBlock(x, y, z);
      const replaceable = target === Block.Air ||
        (BLOCK_FLAGS[target] & BlockFlag.Passable) !== 0;

      if (!overlapsPlayer && replaceable && this.world.setBlock(x, y, z, placing)) {
        this.inventory.consumeHeld(1);
        this.startSwing();
        return { kind: 'place', block: placing, x, y, z };
      }
    }

    return null;
  }

  /** Starts a swing, unless one is already most of the way through. */
  startSwing(): void {
    if (this.swing < 0.55) return;
    this.swing = 0;
  }

  /** Walk-cycle phase and amount, so the hand can bob with the camera. */
  get handBob(): { phase: number; amount: number } {
    return { phase: this.bobPhase, amount: this.bobAmount };
  }

  /**
   * Filling and emptying a bucket.
   *
   * Only a **source** fills it, as in the reference: scooping a flow would let
   * a player multiply water out of a stream, and the fluid simulation is built
   * on sources being the only thing that lasts.
   */
  private useBucket(id: number): BlockEvent | null {
    const c = this.camera;
    const hit = this.world.raycast(
      c.position[0], c.position[1], c.position[2],
      c.forward[0], c.forward[1], c.forward[2],
      REACH, true,
    );
    if (!hit) return null;

    const carried = bucketHolds(id);

    if (carried === Block.Air) {
      // Empty: scoop, if the crosshair is on a source.
      if (FLUID_LEVEL[hit.block] !== 0) return null;
      if (!this.world.setBlock(hit.x, hit.y, hit.z, Block.Air)) return null;
      const filled = FLUID_KIND[hit.block] === 2 ? Item.LavaBucket : Item.WaterBucket;
      this.inventory.consumeHeld(1);
      const left = this.inventory.add(stack(filled, 1));
      if (left > 0) this.inventory.set(this.inventory.selected, stack(filled, 1));
      this.startSwing();
      return { kind: 'use', block: hit.block, x: hit.x, y: hit.y, z: hit.z };
    }

    // Full: pour into the cell the ray stopped in if that cell can hold it,
    // otherwise into the one in front of the face.
    const intoHit = hit.block === Block.Air ||
      (BLOCK_FLAGS[hit.block] & BlockFlag.Passable) !== 0;
    const x = intoHit ? hit.x : hit.x + hit.nx;
    const y = intoHit ? hit.y : hit.y + hit.ny;
    const z = intoHit ? hit.z : hit.z + hit.nz;

    const target = this.world.getBlock(x, y, z);
    const replaceable = target === Block.Air ||
      (BLOCK_FLAGS[target] & BlockFlag.Passable) !== 0;
    if (!replaceable) return null;
    if (!this.world.setBlock(x, y, z, FLUID_SOURCE[FLUID_KIND[carried]])) return null;

    this.inventory.consumeHeld(1);
    const left = this.inventory.add(stack(Item.Bucket, 1));
    if (left > 0) this.inventory.set(this.inventory.selected, stack(Item.Bucket, 1));
    this.startSwing();
    return { kind: 'place', block: carried, x, y, z };
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

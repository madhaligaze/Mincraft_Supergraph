/**
 * Sound.
 *
 * The same two-source shape as the material system, and for the same reason: a
 * sample set is used where one is present, and synthesis covers the rest.
 *
 *   * `public/sounds/`, extracted from a local Minecraft install by
 *     `scripts/extract-sounds.mjs`. Footsteps, block breaking, rain, thunder,
 *     cave ambience — everything a recording does better than an oscillator.
 *   * Synthesis for what no sample set has at the right length: wind, which is
 *     continuous and has to follow the same gust value that bends the grass,
 *     and the whole set of footsteps and impacts when nothing is extracted, so
 *     the engine is never silent.
 *
 * Nothing here starts before the player presses Play. A browser refuses to run
 * an AudioContext without a gesture, and that click is the only one the game is
 * guaranteed to get.
 */

import { Block, BLOCK_SOUND, SOUND_FAMILIES, type SoundFamily } from '../world/blocks.ts';

const SOUND_ROOT = 'sounds';

/** Blocks per footstep. A shade over two, which is roughly a walking stride. */
const STRIDE = 2.15;

export interface AmbienceState {
  /** 0..1 rain intensity. */
  rain: number;
  /** 0..1 wind strength — the same value that drives the grass. */
  wind: number;
  /** 0..1 how much sky the player can see; low means underground. */
  skyVisibility: number;
  /** The camera is inside a water block. */
  underwater: boolean;
}

/**
 * Families that have no set of their own in a Minecraft sound pack.
 *
 * Glass is walked on like stone and only breaks differently; liquids have no
 * footstep at all, because when you are in one you are swimming.
 */
const STEP_ALIAS: Partial<Record<SoundFamily, SoundFamily | null>> = {
  glass: 'stone',
  water: null,
  lava: null,
};

/** Centre frequency and decay of the synthesised fallback, per family. */
const SYNTH: Record<SoundFamily, { freq: number; decay: number; q: number }> = {
  stone: { freq: 780, decay: 0.09, q: 1.6 },
  grass: { freq: 1500, decay: 0.11, q: 0.8 },
  gravel: { freq: 1100, decay: 0.13, q: 1.1 },
  sand: { freq: 2400, decay: 0.10, q: 0.7 },
  snow: { freq: 3000, decay: 0.12, q: 0.6 },
  wood: { freq: 520, decay: 0.10, q: 2.2 },
  cloth: { freq: 900, decay: 0.09, q: 0.7 },
  glass: { freq: 3200, decay: 0.16, q: 4.0 },
  water: { freq: 1800, decay: 0.18, q: 0.6 },
  lava: { freq: 260, decay: 0.30, q: 1.2 },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Muffles everything when the head is under water. */
  private muffle: BiquadFilterNode | null = null;

  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;

  private manifest: Record<string, number> | null = null;
  private readonly cache = new Map<string, AudioBuffer[]>();
  private readonly loading = new Set<string>();

  private volume = 0.7;
  private stepDistance = 0;
  private rainTimer = 0;
  private caveTimer = 60;

  /** True once the context exists and the graph is running. */
  get running(): boolean {
    return this.ctx !== null;
  }

  /**
   * What the engine currently has. Read by `scripts/audiocheck.mjs`: sound is
   * the one subsystem a screenshot cannot verify, so the check drives it from
   * outside and looks at which sample groups actually decoded.
   */
  state(): {
    running: boolean; contextState: string; usingSamples: boolean;
    loaded: string[]; pending: string[];
  } {
    return {
      running: this.ctx !== null,
      contextState: this.ctx?.state ?? 'none',
      usingSamples: this.manifest !== null,
      loaded: [...this.cache.keys()].sort(),
      pending: [...this.loading],
    };
  }

  /** True when a sample set was found; false means everything is synthesised. */
  get usingSamples(): boolean {
    return this.manifest !== null;
  }

  /**
   * Creates the audio graph. Must be called from a user gesture, and is safe to
   * call again — a second press of Play resumes a context the browser
   * suspended rather than building a second one.
   */
  async start(volume = this.volume): Promise<void> {
    this.volume = volume;

    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(this.muffle);

    this.buildNoiseLoops();
    void this.loadManifest();
  }

  /**
   * Silences everything while the game is paused.
   *
   * Not just politeness: the ambience follows the weather every frame, and a
   * paused game stops calling `update`, so wind and rain would otherwise hang
   * at whatever level they had when the player hit Escape.
   */
  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // Sample set
  // -------------------------------------------------------------------------

  private async loadManifest(): Promise<void> {
    try {
      const response = await fetch(`${SOUND_ROOT}/sounds.json`, { cache: 'force-cache' });
      if (!response.ok) return;
      const data = await response.json() as { groups?: Record<string, number> };
      this.manifest = data.groups ?? null;
    } catch {
      // No sample set: everything falls through to synthesis.
    }
  }

  /**
   * Variants of a group, or null while they are still loading.
   *
   * Loading is started on first use and never awaited: a footstep that arrives
   * before its samples do is simply dropped, and the next one — a stride later
   * — plays. Blocking the frame to wait for a decode would be worse than a
   * missing step.
   */
  private group(name: string): AudioBuffer[] | null {
    const cached = this.cache.get(name);
    if (cached) return cached;
    if (!this.manifest || this.loading.has(name)) return null;

    const count = this.manifest[name];
    if (!count) return null;

    this.loading.add(name);
    void this.loadGroup(name, count);
    return null;
  }

  private async loadGroup(name: string, count: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    const buffers: AudioBuffer[] = [];
    for (let i = 1; i <= count; i++) {
      try {
        const response = await fetch(`${SOUND_ROOT}/${name}${i}.ogg`, { cache: 'force-cache' });
        if (!response.ok) continue;
        buffers.push(await ctx.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // A variant that fails to decode costs the set nothing but variety.
      }
    }

    if (buffers.length > 0) this.cache.set(name, buffers);
    this.loading.delete(name);
  }

  /** Plays one random variant. Returns false when the group is unavailable. */
  private playSample(name: string, gain: number, rate: number, pan = 0): boolean {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return false;

    const buffers = this.group(name);
    if (!buffers || buffers.length === 0) return false;

    const source = ctx.createBufferSource();
    source.buffer = buffers[(Math.random() * buffers.length) | 0];
    source.playbackRate.value = rate;

    const amp = ctx.createGain();
    amp.gain.value = gain;

    if (pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      source.connect(amp).connect(panner).connect(master);
    } else {
      source.connect(amp).connect(master);
    }

    source.start();
    return true;
  }

  // -------------------------------------------------------------------------
  // Synthesis
  // -------------------------------------------------------------------------

  /**
   * Two seconds of brown noise, shared by wind and rain.
   *
   * Brown rather than white: integrating the noise tilts it down at 6 dB per
   * octave, which is the difference between wind and radio static. Rain gets
   * the same buffer back through a high-pass, because rain is the same
   * spectrum tilted the other way.
   */
  private buildNoiseLoops(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let last = 0;
    for (let i = 0; i < length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    // Cross-fade the tail into the head so the two-second loop has no seam.
    const blend = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < blend; i++) {
      const t = i / blend;
      data[i] = data[i] * t + data[length - blend + i] * (1 - t);
    }
    this.noise = buffer;

    const makeLoop = (
      type: BiquadFilterType, freq: number,
    ): [GainNode, BiquadFilterNode] => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      source.connect(filter).connect(gain).connect(master);
      source.start();
      return [gain, filter];
    };

    [this.windGain, this.windFilter] = makeLoop('lowpass', 420);
    [this.rainGain, this.rainFilter] = makeLoop('highpass', 900);
  }

  /**
   * A footstep or an impact, built from noise rather than a recording.
   *
   * A band-passed burst with a fast attack and a short exponential tail is
   * enough: the ear reads material from the centre frequency and the decay
   * length, not from the waveform.
   */
  private playSynth(family: SoundFamily, gain: number, rate: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;

    const spec = SYNTH[family];
    const now = ctx.currentTime;
    const decay = spec.decay / rate;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    // Start at a random point in the loop so repeats are not identical.
    const offset = Math.random() * (this.noise.duration - decay - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = spec.freq * rate;
    filter.Q.value = spec.q;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0005, now + decay);

    source.connect(filter).connect(amp).connect(master);
    source.start(now, Math.max(0, offset), decay + 0.02);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private familyOf(block: number): SoundFamily {
    return SOUND_FAMILIES[BLOCK_SOUND[block]] ?? 'stone';
  }

  /**
   * Advances the walk cycle. Call every frame with the distance covered and the
   * block under the player; the stride, not the frame rate, decides when a step
   * actually sounds.
   */
  walk(distance: number, block: number, wetness: number): void {
    if (!this.ctx || block === Block.Air) {
      this.stepDistance = 0;
      return;
    }

    this.stepDistance += distance;
    if (this.stepDistance < STRIDE) return;
    this.stepDistance = 0;
    this.step(block, wetness, 0.3);
  }

  /** One footstep on `block`. */
  step(block: number, wetness = 0, gain = 0.3): void {
    if (!this.ctx) return;

    let family = this.familyOf(block);
    const alias = STEP_ALIAS[family];
    if (alias === null) return;
    if (alias) family = alias;

    const rate = 0.9 + Math.random() * 0.25;
    // Wet grass is its own recorded set; damp anything else very slightly.
    const name = family === 'grass' && wetness > 0.45 ? 'step/wet_grass' : `step/${family}`;
    if (!this.playSample(name, gain, rate)) this.playSynth(family, gain * 0.6, rate);
  }

  /** Landing after a fall; louder and lower the harder the impact. */
  land(speed: number, block: number, wetness = 0): void {
    if (!this.ctx || speed < 3 || block === Block.Air) return;
    this.stepDistance = 0;
    this.step(block, wetness, Math.min(0.75, 0.18 + speed * 0.045));
  }

  /** A block being broken. */
  dig(block: number): void {
    if (!this.ctx) return;
    const family = this.familyOf(block);
    const rate = 0.92 + Math.random() * 0.2;
    // Glass has no dig set — it is the one material that shatters instead.
    const name = family === 'glass' ? 'random/glass' : `dig/${family}`;
    if (!this.playSample(name, 0.42, rate)) this.playSynth(family, 0.3, rate * 0.8);
  }

  /** A block being placed: the same set as breaking, shorter and quieter. */
  place(block: number): void {
    if (!this.ctx) return;
    const family = this.familyOf(block);
    const rate = 1.05 + Math.random() * 0.15;
    if (!this.playSample(`dig/${family}`, 0.34, rate)) this.playSynth(family, 0.24, rate);
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------

  /** Follows the weather and where the player is. Call once per frame. */
  update(dt: number, state: AmbienceState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    // Wind. The gust term is the audible half of what the vertex shaders are
    // already doing to the grass, so the two move together.
    if (this.windGain && this.windFilter) {
      const outside = 0.25 + state.skyVisibility * 0.75;
      const level = state.wind * outside * 0.16 * (state.underwater ? 0.2 : 1);
      this.windGain.gain.setTargetAtTime(level, now, 0.6);
      this.windFilter.frequency.setTargetAtTime(320 + state.wind * 520, now, 0.8);
    }

    // Rain: a synthesised hiss underneath, plus recorded layers on top of it.
    // Heavier rain also reaches lower: drizzle is all hiss, a downpour has body.
    if (this.rainGain && this.rainFilter) {
      const level = state.rain * (0.2 + state.skyVisibility * 0.8) * 0.1;
      this.rainGain.gain.setTargetAtTime(state.underwater ? 0 : level, now, 0.5);
      this.rainFilter.frequency.setTargetAtTime(1600 - state.rain * 900, now, 0.5);
    }

    if (state.rain > 0.03 && !state.underwater) {
      this.rainTimer -= dt;
      if (this.rainTimer <= 0) {
        this.rainTimer = 0.85;
        this.playSample(
          'ambient/weather/rain',
          0.5 * state.rain * (0.25 + state.skyVisibility * 0.75),
          0.95 + Math.random() * 0.1,
          Math.random() * 1.6 - 0.8,
        );
      }
    }

    // Cave ambience: rare, quiet, and only where the sky is shut out. Its whole
    // job is to make an enclosed space feel enclosed.
    if (state.skyVisibility < 0.3) {
      this.caveTimer -= dt;
      if (this.caveTimer <= 0) {
        this.caveTimer = 45 + Math.random() * 90;
        this.playSample('ambient/cave/cave', 0.35, 1, Math.random() * 1.4 - 0.7);
      }
    } else {
      this.caveTimer = Math.max(this.caveTimer, 20);
    }

    if (this.muffle) {
      this.muffle.frequency.setTargetAtTime(state.underwater ? 480 : 20000, now, 0.15);
    }
  }
}

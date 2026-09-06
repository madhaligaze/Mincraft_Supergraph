/**
 * Sky state: the day/night cycle, weather, and the three atmosphere LUTs.
 *
 * The transmittance and multiple-scattering tables depend only on the
 * atmosphere model, so they are baked once at startup. The sky-view table is
 * rebuilt each frame at 192x108 — cheap, and it means every other pass can read
 * the finished sky with a single texture fetch instead of raymarching.
 */

import { Program, type ProgramCache } from './shader.ts';
import { RenderTarget, FullscreenTriangle, formats } from './target.ts';
import { GLState } from './gl.ts';
import { clamp, saturate, lerp, TAU, type Vec3, vec3, v3normalize, v3set } from '../core/math.ts';
import { SEA_LEVEL } from '../world/constants.ts';

const TRANSMITTANCE_WIDTH = 256;
const TRANSMITTANCE_HEIGHT = 64;
const MULTISCATTER_SIZE = 32;
const SKYVIEW_WIDTH = 192;
const SKYVIEW_HEIGHT = 108;

/** Kilometres, mirroring the constants in lib/atmosphere.glsl. */
const GROUND_RADIUS = 6360.0;

/** Peak illuminance of the sun in the renderer's arbitrary HDR units. */
const SUN_INTENSITY = 13.0;
const MOON_INTENSITY = 0.055;

/** Inclination of the sun's daily arc, in radians. */
const SUN_TILT = 0.38;

export interface WeatherState {
  /** 0..1 precipitation intensity. */
  rain: number;
  /** 0..1 how wet surfaces are; lags behind `rain`. */
  wetness: number;
  /** Wind speed multiplier. */
  wind: number;
  /** Wind direction in radians. */
  windAngle: number;
  /** 0..1 how much of the precipitation falls as snow. */
  snow: number;
}

export class Sky {
  /** Seconds for a full day/night cycle. */
  dayLength = 1200;
  /** 0..1 through the cycle; 0.25 is sunrise, 0.5 noon, 0.75 sunset. */
  timeOfDay = 0.32;
  paused = false;

  readonly sunDirection: Vec3 = vec3(0, 1, 0);
  readonly moonDirection: Vec3 = vec3(0, -1, 0);
  readonly sunColor: Vec3 = vec3(1, 1, 1);
  readonly moonColor: Vec3 = vec3(0.72, 0.80, 1.0);

  sunIntensity = 0;
  moonIntensity = 0;
  /** 1 in full daylight, 0 at night. */
  dayFactor = 1;
  nightFactor = 0;

  readonly weather: WeatherState = {
    rain: 0, wetness: 0, wind: 0.55, windAngle: 0.7, snow: 0,
  };

  /** Seconds until the next weather change is considered. */
  private weatherTimer = 90;
  private weatherTarget = 0;

  readonly transmittance: RenderTarget;
  readonly multiScatter: RenderTarget;
  readonly skyView: RenderTarget;

  // Not readonly: the renderer throws the whole program cache away and rebuilds
  // it whenever a shader define changes, and these have to be rebuilt with it.
  private transmittanceProgram!: Program;
  private multiScatterProgram!: Program;
  private skyViewProgram!: Program;

  private bakedStatic = false;
  cameraRadiusKm = GROUND_RADIUS;
  /** (zenith-to-horizon, horizon-to-nadir) angles, a frame constant. */
  readonly horizonAngles = new Float32Array(2);

  /**
   * Allocates the three LUT targets. The programs are *not* built here — the
   * renderer builds them, and rebuilds them, through `createPrograms`.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly state: GLState,
    private readonly triangle: FullscreenTriangle,
  ) {
    const f = formats(gl);

    this.transmittance = new RenderTarget(gl, {
      color: [f.hdr], label: 'transmittance',
    }, TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);

    this.multiScatter = new RenderTarget(gl, {
      color: [f.hdr], label: 'multiscatter',
    }, MULTISCATTER_SIZE, MULTISCATTER_SIZE);

    this.skyView = new RenderTarget(gl, {
      color: [f.hdr], label: 'skyview',
    }, SKYVIEW_WIDTH, SKYVIEW_HEIGHT);

  }

  /**
   * Builds the three atmosphere programs against a program cache.
   *
   * Separate from the constructor because the renderer disposes its whole cache
   * and builds a new one whenever a shader define changes — and when it did,
   * these three were left pointing at deleted programs. The transmittance and
   * multiple-scattering textures survived, because textures are not owned by
   * the cache, but the per-frame sky-view pass then ran with a dead program and
   * filled its LUT with whatever the driver felt like. Everything downstream
   * reads that LUT — the dome, the fog, the ambient on every block face — so
   * the entire frame came out one flat colour. Changing quality preset in the
   * settings panel was enough to trigger it.
   *
   * The march step count is picked up here too, which is what makes
   * `skyViewSteps` an actual setting rather than a value read once at startup.
   */
  createPrograms(programs: ProgramCache, skyViewSteps: number): void {
    this.transmittanceProgram = programs.create(
      'sky.transmittance', 'fullscreen.vert.glsl', 'sky/transmittance.frag.glsl',
    );
    this.multiScatterProgram = programs.create(
      'sky.multiscatter', 'fullscreen.vert.glsl', 'sky/multiscatter.frag.glsl',
    );
    this.skyViewProgram = programs.create(
      'sky.skyview', 'fullscreen.vert.glsl', 'sky/skyview.frag.glsl',
      { MARCH_STEPS: Math.max(8, Math.round(skyViewSteps)) },
    );
    // The static tables have to be laid down again by the new programs.
    this.bakedStatic = false;
  }

  /** Advances time and weather. */
  update(dt: number): void {
    if (!this.paused) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;
    }
    this.updateWeather(dt);
    this.updateCelestials();
  }

  private updateWeather(dt: number): void {
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      // Weather changes on a slow, lumpy schedule: mostly clear, occasionally
      // a long spell of rain.
      const roll = Math.random();
      this.weatherTarget = roll < 0.62 ? 0 : roll < 0.9 ? 0.45 : 1.0;
      this.weatherTimer = 120 + Math.random() * 240;
    }

    // Rain ramps quickly, dries slowly — puddles outlive the shower.
    const rate = this.weatherTarget > this.weather.rain ? 0.06 : 0.03;
    this.weather.rain += (this.weatherTarget - this.weather.rain) * saturate(rate * dt * 4);
    this.weather.wetness += (this.weather.rain - this.weather.wetness) *
      saturate((this.weather.rain > this.weather.wetness ? 0.09 : 0.018) * dt * 4);

    this.weather.wind = 0.35 + this.weather.rain * 0.75 +
      Math.sin(this.timeOfDay * TAU * 3) * 0.12;
    this.weather.windAngle += dt * 0.012;
  }

  private updateCelestials(): void {
    // The arc starts at the eastern horizon and is tilted out of the vertical
    // plane, which is what stops the sun from passing exactly overhead and
    // gives long, angled shadows for most of the day.
    const angle = this.timeOfDay * TAU - Math.PI * 0.5;
    const cosT = Math.cos(SUN_TILT);
    const sinT = Math.sin(SUN_TILT);

    v3set(this.sunDirection, Math.cos(angle), Math.sin(angle) * cosT, Math.sin(angle) * sinT);
    v3normalize(this.sunDirection, this.sunDirection);

    v3set(this.moonDirection, -this.sunDirection[0], -this.sunDirection[1], -this.sunDirection[2]);

    this.dayFactor = saturate((this.sunDirection[1] + 0.08) / 0.22);
    this.nightFactor = saturate((-this.sunDirection[1] - 0.02) / 0.2);

    // The sun's brightness is *not* faded by elevation. Atmospheric extinction
    // already does that — and does it per wavelength, which is the entire
    // reason a sunset is red. Scaling the intensity down as well would double
    // count the dimming and leave dusk almost black.
    //
    // The only fade applied is a soft cutoff once the sun is far enough below
    // the horizon that the scattering integral has nothing left to find.
    const horizonFade = saturate((this.sunDirection[1] + 0.14) / 0.12);
    this.sunIntensity = SUN_INTENSITY * horizonFade;
    this.moonIntensity = MOON_INTENSITY * this.nightFactor;

    this.computeSunColor();
  }

  /**
   * Atmospheric extinction along the path to the sun, computed on the CPU with
   * the same model the GPU LUT uses.
   *
   * The shading passes need this value as a plain uniform, and reading it back
   * from the LUT would stall the pipeline; forty iterations of the same
   * integral costs nothing here and stays consistent with the sky.
   */
  private computeSunColor(): void {
    const radius = this.cameraRadiusKm;
    const cosZenith = clamp(this.sunDirection[1], -1, 1);

    const ATMOSPHERE_RADIUS = 6460.0;
    const discriminant = radius * radius * (cosZenith * cosZenith - 1) +
      ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS;
    const distance = Math.max(0, -radius * cosZenith + Math.sqrt(Math.max(discriminant, 0)));

    const steps = 32;
    const dt = distance / steps;
    let odR = 0, odG = 0, odB = 0;

    for (let i = 0; i < steps; i++) {
      const d = (i + 0.5) * dt;
      const r = Math.sqrt(d * d + 2 * radius * cosZenith * d + radius * radius);
      const altitude = r - GROUND_RADIUS;

      const rayleighDensity = Math.exp(-altitude / 8.0);
      const mieDensity = Math.exp(-altitude / 1.2);
      const ozoneDensity = Math.max(0, 1 - Math.abs(altitude - 25.0) / 15.0);

      const mie = (3.996e-3 + 4.4e-3) * mieDensity;

      odR += (5.802e-3 * rayleighDensity + mie + 0.650e-3 * ozoneDensity) * dt;
      odG += (13.558e-3 * rayleighDensity + mie + 1.881e-3 * ozoneDensity) * dt;
      odB += (33.100e-3 * rayleighDensity + mie + 0.085e-3 * ozoneDensity) * dt;
    }

    // Overcast attenuates the *direct* sun only. Folding it into the colour
    // rather than the intensity is deliberate: the intensity also drives the
    // sky-view LUT, and an overcast sky is diffuse and bright, not dark. This
    // way the disc and the cast shadows fade while the dome stays lit.
    const overcast = 1 - this.weather.rain * 0.82;

    this.sunColor[0] = Math.exp(-odR) * overcast;
    this.sunColor[1] = Math.exp(-odG) * overcast;
    this.sunColor[2] = Math.exp(-odB) * overcast;

    // The moon is sunlight bounced off a grey body; tint it cool so night reads
    // as night even when the exposure lifts it.
    const moonTint = 0.62;
    this.moonColor[0] = lerp(this.sunColor[0], 0.68, moonTint);
    this.moonColor[1] = lerp(this.sunColor[1], 0.76, moonTint);
    this.moonColor[2] = lerp(this.sunColor[2], 1.0, moonTint);
  }

  /** Camera height in blocks; 1 block is treated as 1 metre. */
  setCameraHeight(worldY: number): void {
    const radius = GROUND_RADIUS + Math.max(0.0005, (worldY - SEA_LEVEL) * 0.001 + 0.002);
    this.cameraRadiusKm = radius;

    const horizonDistance = Math.sqrt(Math.max(0, radius * radius - GROUND_RADIUS * GROUND_RADIUS));
    const beta = Math.acos(clamp(horizonDistance / radius, -1, 1));
    this.horizonAngles[0] = Math.PI - beta;
    this.horizonAngles[1] = beta;
  }

  /** Bakes the two static LUTs. Safe to call more than once; it no-ops after. */
  bakeStatic(): void {
    if (this.bakedStatic) return;
    const gl = this.gl;

    this.state.setDepthTest(false);
    this.state.setCull(false);
    this.state.setBlend(false);

    this.state.bindFramebuffer(this.transmittance.fbo);
    this.state.viewport(0, 0, this.transmittance.width, this.transmittance.height);
    this.state.useProgram(this.transmittanceProgram.handle);
    this.triangle.draw();

    this.state.bindFramebuffer(this.multiScatter.fbo);
    this.state.viewport(0, 0, this.multiScatter.width, this.multiScatter.height);
    this.state.useProgram(this.multiScatterProgram.handle);
    this.state.bindTexture(0, gl.TEXTURE_2D, this.transmittance.texture);
    this.multiScatterProgram.int('uTransmittanceLut', 0);
    this.triangle.draw();

    this.state.invalidate();
    this.bakedStatic = true;
  }

  /** Rebuilds the per-frame sky-view LUT. The scene UBO must already be bound. */
  renderSkyView(): void {
    const gl = this.gl;

    this.state.setDepthTest(false);
    this.state.setCull(false);
    this.state.setBlend(false);

    this.state.bindFramebuffer(this.skyView.fbo);
    this.state.viewport(0, 0, this.skyView.width, this.skyView.height);
    this.state.useProgram(this.skyViewProgram.handle);

    this.state.bindTexture(0, gl.TEXTURE_2D, this.transmittance.texture);
    this.state.bindTexture(1, gl.TEXTURE_2D, this.multiScatter.texture);
    this.skyViewProgram.int('uTransmittanceLut', 0);
    this.skyViewProgram.int('uMultiScatterLut', 1);
    this.skyViewProgram.float('uCameraRadiusKm', this.cameraRadiusKm);

    this.triangle.draw();
  }

  bindBlocks(): void {
    this.skyViewProgram.bindBlock('Scene', 0);
  }

  /** Human-readable clock for the debug overlay. */
  clockString(): string {
    const totalMinutes = Math.floor(this.timeOfDay * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  dispose(): void {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.skyView.dispose();
  }
}

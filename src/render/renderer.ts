/**
 * The frame graph.
 *
 * Pass order, and why:
 *
 *   1  shadow cascades          depth only, from the sun
 *   2  depth prepass            lays down depth + geometric normals
 *   3  SSAO + bilateral blur    half resolution, reads the prepass
 *   4  opaque forward           GEQUAL, depth writes off, early-Z does the work
 *   5  cutout forward           leaves and plants, alpha tested
 *   6  grass                    GPU-instanced blades
 *   7  sky                      only where nothing was drawn
 *   8  clouds                   quarter res, composited over the sky
 *   9  colour + depth copy      so water can read what is behind it
 *  10  water                    SSR, refraction, absorption
 *  11  translucent              glass and ice
 *  12  weather                  rain and snow particles
 *  13  selection outline
 *  14  TAA resolve              reprojects through depth, no velocity buffer
 *  15  bloom                    threshold, downsample chain, tent upsample
 *  16  composite                exposure, ACES, lens effects, encode
 *
 * A forward renderer with a depth prepass beats a deferred one here: the
 * G-buffer traffic a deferred pipeline needs is exactly what an integrated GPU
 * cannot afford, while the prepass costs only vertex work and buys back the
 * overdraw savings deferred would have given.
 */

import { GLState, type GLCaps } from './gl.ts';
import { Program, ProgramCache } from './shader.ts';
import { RenderTarget, FullscreenTriangle, formats } from './target.ts';
import { ShadowMaps } from './shadows.ts';
import { Sky } from './sky.ts';
import { ChunkGeometry, type DrawItem } from './chunkGeometry.ts';
import { createMaterials, type MaterialTextures } from './textures.ts';
import { generateCloudNoise, type CloudNoise } from './cloudNoise.ts';
import { GpuProfiler } from './gpuProfiler.ts';
import { Bucket, type SectionMeshResult } from '../world/mesher.ts';
import { GI_CELL, GI_SIZE_XZ, GI_SIZE_Y, type GiResult } from '../world/gi.ts';
import { CHUNK_SIZE, SEA_LEVEL } from '../world/constants.ts';
import type { MeshSink } from '../world/world.ts';
import type { Settings } from '../core/settings.ts';
import {
  Frustum, mat4, vec3, Vec3, m4mul, m4copy, m4invert, m4perspectiveReverseZ,
  m4lookAt, v3set, radicalInverse2, halton3, DEG2RAD, clamp,
} from '../core/math.ts';

/** std140 layout of the Scene uniform block, in floats. */
const SCENE_FLOATS = 120;

const MAX_POINT_LIGHTS = 16;

/**
 * Flat colour per bucket for debug view 8.
 *
 * Which pass actually painted a pixel is not something the other debug channels
 * can answer: they all show what the *chunk* shader computed, so a pixel that
 * came from water or from instanced grass looks like an oddly shaded block
 * face. Painting each pass a solid colour answers it in one screenshot.
 */
const BUCKET_DEBUG_COLOR: ReadonlyArray<readonly [number, number, number]> = [
  [0.20, 0.80, 0.35],   // opaque
  [0.95, 0.85, 0.20],   // cutout
  [0.95, 0.25, 0.20],   // water
  [0.30, 0.55, 1.00],   // translucent
];

/** Instanced grass is not a bucket, but it paints pixels the same way. */
const GRASS_DEBUG_COLOR: readonly [number, number, number] = [1.0, 0.35, 0.9];

/**
 * Concentric rings of grass, innermost first: `outer` is a fraction of the
 * grass distance, `blades` the count per block.
 *
 * Thick underfoot, thinning outward — a blade at the far edge is thinner than
 * a pixel, and drawing sixteen of them per block there buys nothing but vertex
 * invocations.
 *
 * What keeps the steps invisible: blade positions are hashed from the cell and
 * the blade index, so the first N blades of a dense ring are the very same
 * blades, in the very same places, as the sparse ring beyond it. Only the
 * surplus disappears, and it fades rather than pops. Blade size is a smooth
 * function of distance instead of a per-ring constant, for the same reason.
 */
const GRASS_RINGS: ReadonlyArray<{ outer: number; blades: number }> = [
  { outer: 0.28, blades: 16 },
  { outer: 0.60, blades: 5 },
  { outer: 1.0, blades: 2 },
];

/** How much wider and taller a blade gets at the far edge of the field. */
const GRASS_FAR_SCALE: readonly [number, number] = [2.1, 1.25];

export interface FrameState {
  cameraPosition: Vec3;
  cameraForward: Vec3;
  cameraUp: Vec3;
  /** Seconds since start. */
  time: number;
  deltaTime: number;
  /** Highlighted block, or null. */
  selection: { x: number; y: number; z: number } | null;
  underwater: boolean;
  /** Linear RGB tint of the water the camera is inside. */
  underwaterTint: Vec3;
  /** How far the camera is below the surface, 0..1 over the first ~20 blocks. */
  underwaterDepth: number;
  /** Remaining breath, 1 full to 0 empty. Closes the vignette as it empties. */
  breath: number;
  /** Flat [x, y, z, intensity] tuples. */
  pointLights: Float32Array;
  pointLightCount: number;
  /** Fog density multiplier from the biome the camera is in. */
  biomeFog: number;
}

export interface RenderStats {
  drawCalls: number;
  visibleQuads: number;
  totalQuads: number;
  sections: number;
  shadowDraws: number;
  internalWidth: number;
  internalHeight: number;
}

export class Renderer implements MeshSink {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GLState;
  private readonly caps: GLCaps;
  /** Rebuilt wholesale when a shader define changes, so not readonly. */
  private programs: ProgramCache;
  private readonly triangle: FullscreenTriangle;

  readonly geometry: ChunkGeometry;
  readonly sky: Sky;
  readonly profiler: GpuProfiler;
  private shadows: ShadowMaps | null = null;
  private materials: MaterialTextures | null = null;
  private cloudNoise: CloudNoise | null = null;

  // Render targets
  private main!: RenderTarget;
  private copy!: RenderTarget;
  private aoTargets: RenderTarget[] = [];
  private taaTargets: RenderTarget[] = [];
  private cloudTarget!: RenderTarget;
  /** Quarter-resolution light shafts, composited back additively. */
  private shaftTarget!: RenderTarget;
  private bloomTargets: RenderTarget[] = [];
  /** 64x64 -> 16x16 -> 4x4 -> 1x1 log-luminance reduction chain. */
  private luminanceTargets: RenderTarget[] = [];
  /** 1x1 ping-pong holding the eye-adapted luminance across frames. */
  private adaptationTargets: RenderTarget[] = [];
  private adaptationIndex = 0;
  private adaptationValid = false;

  private tintAtlas: WebGLTexture | null = null;
  private tintAtlasSize = 512;

  /** Indirect light around the player, one texel per 4x4x4 blocks. */
  private giVolume: WebGLTexture | null = null;
  /** False until the first bake lands; until then the shader has nothing. */
  private giReady = false;

  private emptyVao: WebGLVertexArrayObject;
  private sceneUbo: WebGLBuffer;
  private readonly sceneData = new Float32Array(SCENE_FLOATS);

  // Matrices
  private readonly proj = mat4();
  private readonly view = mat4();
  private readonly viewProj = mat4();
  private readonly prevViewProj = mat4();
  private readonly invViewProj = mat4();
  private readonly jitteredProj = mat4();
  private readonly frustum = new Frustum();
  private readonly scratchTarget = vec3();

  private readonly pointLightPos = new Float32Array(MAX_POINT_LIGHTS * 4);
  private readonly pointLightColor = new Float32Array(MAX_POINT_LIGHTS * 4);

  private readonly shadowList: DrawItem[] = [];

  private frameIndex = 0;
  private jitterX = 0;
  private jitterY = 0;
  private prevJitterX = 0;
  private prevJitterY = 0;
  private historyIndex = 0;
  private historyValid = false;

  private width = 1;
  private height = 1;
  private internalWidth = 1;
  private internalHeight = 1;

  settings: Settings;
  /** 0 = normal shading; see uDebugView in chunk.frag.glsl. */
  debugView = 0;
  readonly stats: RenderStats = {
    drawCalls: 0, visibleQuads: 0, totalQuads: 0, sections: 0,
    shadowDraws: 0, internalWidth: 1, internalHeight: 1,
  };

  constructor(
    gl: WebGL2RenderingContext,
    caps: GLCaps,
    settings: Settings,
  ) {
    this.gl = gl;
    this.caps = caps;
    this.settings = settings;
    this.state = new GLState(gl);
    this.programs = new ProgramCache(gl, caps.parallelShaderCompile);
    this.triangle = new FullscreenTriangle(gl);
    this.geometry = new ChunkGeometry(gl, this.state);

    const vao = gl.createVertexArray();
    const ubo = gl.createBuffer();
    if (!vao || !ubo) throw new Error('Не удалось создать базовые GL-объекты');
    this.emptyVao = vao;
    this.sceneUbo = ubo;

    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, SCENE_FLOATS * 4, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.sky = new Sky(gl, this.state, this.triangle, this.programs, settings.skyViewSteps);
    this.profiler = new GpuProfiler(gl, caps.timerQuery);

    this.createPrograms();
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  private createPrograms(): void {
    const s = this.settings;
    const shadowQuality = s.shadowsEnabled ? s.shadowFilter : 0;

    const chunkDefines = {
      SHADOW_QUALITY: shadowQuality,
      USE_SSAO: s.ssaoEnabled,
      USE_GI: s.giEnabled,
    };

    // Parallax goes on the opaque bucket only. Cutout geometry is cross-shaped
    // plants and leaf shells, where the face is a two-sided billboard with no
    // relief to march, and the translucent bucket is glass and ice, which are
    // flat by construction.
    this.programs.create('chunk.opaque', 'chunk/chunk.vert.glsl', 'chunk/chunk.frag.glsl', {
      ...chunkDefines,
      USE_POM: s.parallaxEnabled,
      POM_STEPS: Math.max(4, s.parallaxSteps),
      POM_SHADOW: s.parallaxEnabled && s.parallaxShadows,
    });
    this.programs.create('chunk.cutout', 'chunk/chunk.vert.glsl', 'chunk/chunk.frag.glsl', {
      ...chunkDefines, ALPHA_TEST: true, FOLIAGE: true,
    });
    this.programs.create('chunk.translucent', 'chunk/chunk.vert.glsl', 'chunk/chunk.frag.glsl', {
      ...chunkDefines, TRANSLUCENT: true,
    });

    this.programs.create('chunk.shadow', 'chunk/shadow.vert.glsl', 'chunk/shadow.frag.glsl');
    this.programs.create('chunk.shadow.cutout', 'chunk/shadow.vert.glsl', 'chunk/shadow.frag.glsl', {
      ALPHA_TEST: true,
    });

    this.programs.create('water', 'water/water.vert.glsl', 'water/water.frag.glsl', {
      SHADOW_QUALITY: shadowQuality,
    });

    this.programs.create('grass', 'grass/grass.vert.glsl', 'grass/grass.frag.glsl', {
      SHADOW_QUALITY: Math.min(shadowQuality, 1),
    });

    this.programs.create('sky', 'fullscreen.vert.glsl', 'sky/sky.frag.glsl');
    this.programs.create('clouds', 'fullscreen.vert.glsl', 'sky/clouds.frag.glsl', {
      MARCH_STEPS: Math.max(8, s.cloudSteps),
      LIGHT_STEPS: s.cloudSteps >= 32 ? 6 : 4,
    });
    this.programs.create('clouds.composite', 'fullscreen.vert.glsl', 'sky/clouds_composite.frag.glsl');

    this.programs.create('ssao', 'fullscreen.vert.glsl', 'post/ssao.frag.glsl', {
      SAMPLE_COUNT: s.ssaoSamples,
    });
    this.programs.create('bilateral', 'fullscreen.vert.glsl', 'post/bilateral.frag.glsl');
    this.programs.create('wet', 'fullscreen.vert.glsl', 'post/wet.frag.glsl');
    this.programs.create('shafts', 'fullscreen.vert.glsl', 'post/shafts.frag.glsl', {
      SHAFT_STEPS: Math.max(4, s.lightShaftSteps),
    });
    this.programs.create('shafts.add', 'fullscreen.vert.glsl', 'post/shafts_add.frag.glsl');
    this.programs.create('taa', 'fullscreen.vert.glsl', 'post/taa.frag.glsl');
    this.programs.create('bloom.down', 'fullscreen.vert.glsl', 'post/bloom_down.frag.glsl');
    this.programs.create('bloom.up', 'fullscreen.vert.glsl', 'post/bloom_up.frag.glsl');
    this.programs.create('composite', 'fullscreen.vert.glsl', 'post/composite.frag.glsl');
    this.programs.create('luminance', 'fullscreen.vert.glsl', 'post/luminance.frag.glsl');
    this.programs.create('luminance.reduce', 'fullscreen.vert.glsl', 'post/luminance_reduce.frag.glsl');
    this.programs.create('adaptation', 'fullscreen.vert.glsl', 'post/adaptation.frag.glsl');

    this.programs.create('rain', 'weather/rain.vert.glsl', 'weather/rain.frag.glsl');
    this.programs.create('selection', 'debug/selection.vert.glsl', 'debug/selection.frag.glsl');
  }

  /** Finishes program linking; call until it returns true. */
  pollPrograms(): boolean {
    return this.programs.poll();
  }

  /** Binds the shared Scene block on every program that uses it. */
  private bindUniformBlocks(): void {
    const names = [
      'chunk.opaque', 'chunk.cutout', 'chunk.translucent',
      'chunk.shadow', 'chunk.shadow.cutout',
      'water', 'grass', 'sky', 'clouds', 'clouds.composite',
      'ssao', 'bilateral', 'taa', 'composite', 'rain', 'selection', 'adaptation', 'wet',
      'shafts', 'shafts.add',
    ];
    for (const name of names) this.programs.get(name).bindBlock('Scene', 0);
    this.sky.bindBlocks();
  }

  /** Builds materials, shadow maps and the tint atlas. */
  async initResources(
    onProgress?: (done: number, total: number, label: string) => void,
  ): Promise<void> {
    const gl = this.gl;
    const s = this.settings;

    this.bindUniformBlocks();

    this.materials = await createMaterials(
      gl, s.textureResolution,
      Math.min(s.anisotropy, this.caps.maxAnisotropy),
      onProgress,
    );

    this.cloudNoise = generateCloudNoise(gl, (fraction) => {
      onProgress?.(Math.round(fraction * 100), 100, 'объёмный шум облаков');
    });

    this.shadows = new ShadowMaps(gl, s.shadowMapSize, s.shadowCascades);

    this.createTintAtlas();
    this.sky.bakeStatic();
    this.state.invalidate();
  }

  /**
   * The toroidal atlas holding per-block biome tints and surface info.
   *
   * Sized to comfortably exceed the render distance so a chunk never aliases
   * onto another chunk's texels; addressing is plain GL_REPEAT, so wrapping is
   * free and no shader ever needs a modulo.
   */
  private createTintAtlas(): void {
    const gl = this.gl;
    const needed = (this.settings.renderDistance * 2 + 4) * CHUNK_SIZE;
    let size = 256;
    while (size < needed) size *= 2;
    size = Math.min(size, 2048);

    if (this.tintAtlas && size === this.tintAtlasSize) return;
    if (this.tintAtlas) gl.deleteTexture(this.tintAtlas);

    this.tintAtlasSize = size;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Не удалось создать атлас биомов');
    this.tintAtlas = texture;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size, size, 4);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  // -------------------------------------------------------------------------
  // MeshSink
  // -------------------------------------------------------------------------

  uploadSection(result: SectionMeshResult): void {
    this.geometry.upload(result);
  }

  discardSection(cx: number, cz: number, sectionY: number): void {
    this.geometry.discardSection(cx, cz, sectionY);
  }

  discardColumn(cx: number, cz: number): void {
    this.geometry.discardColumn(cx, cz);
  }

  uploadAtlasTile(cx: number, cz: number, layers: Uint8Array[]): void {
    const gl = this.gl;
    if (!this.tintAtlas) return;

    const size = this.tintAtlasSize;
    // Chunk origins are multiples of 32 and the atlas is a power of two, so a
    // tile never straddles the wrap boundary.
    const x = ((cx * CHUNK_SIZE) % size + size) % size;
    const y = ((cz * CHUNK_SIZE) % size + size) % size;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tintAtlas);
    for (let layer = 0; layer < layers.length; layer++) {
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, x, y, layer,
        CHUNK_SIZE, CHUNK_SIZE, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, layers[layer],
      );
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.state.invalidate();
  }

  /**
   * Uploads a freshly baked indirect-light grid.
   *
   * The whole 768 KB goes at once rather than in slabs: it arrives about once
   * a second, and one `texImage3D` is cheaper than the bookkeeping that
   * tracking which slabs changed would need.
   */
  uploadGiVolume(result: GiResult): void {
    const gl = this.gl;

    if (!this.giVolume) {
      const texture = gl.createTexture();
      if (!texture) return;
      this.giVolume = texture;
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, GI_SIZE_XZ, GI_SIZE_Y, GI_SIZE_XZ);
      // Horizontally the grid wraps with the world; vertically it covers the
      // whole world already, so its top and bottom simply hold.
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_3D, this.giVolume);
    }

    gl.texSubImage3D(
      gl.TEXTURE_3D, 0, 0, 0, 0,
      GI_SIZE_XZ, GI_SIZE_Y, GI_SIZE_XZ,
      gl.RGBA, gl.UNSIGNED_BYTE, result.data,
    );
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.giReady = true;
    this.state.invalidate();
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  resize(width: number, height: number): void {
    const scale = clamp(this.settings.resolutionScale, 0.4, 1.5);
    const iw = Math.max(2, Math.round(width * scale));
    const ih = Math.max(2, Math.round(height * scale));

    if (iw === this.internalWidth && ih === this.internalHeight && this.main) return;

    this.width = width;
    this.height = height;
    this.internalWidth = iw;
    this.internalHeight = ih;
    this.stats.internalWidth = iw;
    this.stats.internalHeight = ih;

    const gl = this.gl;
    const f = formats(gl);

    if (!this.main) {
      // One colour attachment. The second one existed only for the depth
      // prepass's normals; dropping it saves an RGBA8 buffer and the bandwidth
      // of writing it every frame.
      this.main = new RenderTarget(gl, {
        color: [f.hdr], depth: true, label: 'main',
      }, iw, ih);
      this.copy = new RenderTarget(gl, {
        color: [f.hdr], depth: true, label: 'copy',
      }, iw, ih);
      this.taaTargets = [
        new RenderTarget(gl, { color: [f.hdr], label: 'taa0' }, iw, ih),
        new RenderTarget(gl, { color: [f.hdr], label: 'taa1' }, iw, ih),
      ];
      this.aoTargets = [
        new RenderTarget(gl, { color: [f.ao], label: 'ao0' }, 1, 1),
        new RenderTarget(gl, { color: [f.ao], label: 'ao1' }, 1, 1),
      ];
      this.cloudTarget = new RenderTarget(gl, { color: [f.hdr], label: 'clouds' }, 1, 1);
      this.shaftTarget = new RenderTarget(gl, { color: [f.hdr], label: 'shafts' }, 1, 1);
      for (let i = 0; i < 6; i++) {
        this.bloomTargets.push(
          new RenderTarget(gl, { color: [f.hdrCompact], label: `bloom${i}` }, 1, 1),
        );
      }
      // Fixed-size chain: exposure does not need to track the render
      // resolution, and a fixed size keeps the reduction cost constant.
      for (const size of [64, 16, 4, 1]) {
        this.luminanceTargets.push(
          new RenderTarget(gl, { color: [f.luminance], label: `lum${size}` }, size, size),
        );
      }
      this.adaptationTargets = [
        new RenderTarget(gl, { color: [f.luminance], label: 'adapt0' }, 1, 1),
        new RenderTarget(gl, { color: [f.luminance], label: 'adapt1' }, 1, 1),
      ];
    } else {
      this.main.resize(iw, ih);
      this.copy.resize(iw, ih);
      for (const t of this.taaTargets) t.resize(iw, ih);
    }

    const aoScale = clamp(this.settings.ssaoScale, 0.25, 1);
    for (const t of this.aoTargets) {
      t.resize(Math.round(iw * aoScale), Math.round(ih * aoScale));
    }

    const cloudScale = clamp(this.settings.cloudScale, 0.125, 1);
    this.cloudTarget.resize(Math.round(iw * cloudScale), Math.round(ih * cloudScale));
    // A quarter along each axis: the beams are low-frequency, and the
    // magnification back up is the blur they want anyway.
    this.shaftTarget.resize(Math.max(2, iw >> 2), Math.max(2, ih >> 2));

    let bw = iw;
    let bh = ih;
    for (const t of this.bloomTargets) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      t.resize(bw, bh);
    }

    this.historyValid = false;
  }

  /** Re-creates everything that depends on a settings value. */
  applySettings(settings: Settings): void {
    const previous = this.settings;
    this.settings = settings;

    const needsPrograms =
      previous.shadowFilter !== settings.shadowFilter ||
      previous.shadowsEnabled !== settings.shadowsEnabled ||
      previous.ssaoEnabled !== settings.ssaoEnabled ||
      previous.ssaoSamples !== settings.ssaoSamples ||
      previous.cloudSteps !== settings.cloudSteps ||
      previous.skyViewSteps !== settings.skyViewSteps ||
      previous.parallaxEnabled !== settings.parallaxEnabled ||
      previous.parallaxSteps !== settings.parallaxSteps ||
      previous.parallaxShadows !== settings.parallaxShadows ||
      previous.giEnabled !== settings.giEnabled ||
      previous.lightShaftSteps !== settings.lightShaftSteps;

    if (needsPrograms) {
      // Programs are cheap to rebuild and this only happens from the settings
      // menu, so recompiling the whole set is simpler than tracking which
      // define fed which program.
      this.programs.dispose();
      this.programs = new ProgramCache(this.gl, this.caps.parallelShaderCompile);
      this.createPrograms();
      this.programs.flush();
      this.bindUniformBlocks();
    }

    if (
      previous.shadowMapSize !== settings.shadowMapSize ||
      previous.shadowCascades !== settings.shadowCascades
    ) {
      this.shadows?.dispose();
      this.shadows = new ShadowMaps(this.gl, settings.shadowMapSize, settings.shadowCascades);
    }

    // A resource pack pins the tile size, so the resolution slider only
    // matters for the procedural path. Rebuilding is asynchronous because
    // loading a pack is; the old textures stay bound until it finishes, which
    // is correct — a frame with the previous materials beats a frame with none.
    if (
      (previous.textureResolution !== settings.textureResolution ||
        previous.anisotropy !== settings.anisotropy) &&
      !this.materials?.usingPack
    ) {
      const stale = this.materials;
      void createMaterials(
        this.gl, settings.textureResolution,
        Math.min(settings.anisotropy, this.caps.maxAnisotropy),
      ).then((next) => {
        this.materials = next;
        if (stale) {
          this.gl.deleteTexture(stale.albedo);
          this.gl.deleteTexture(stale.surface);
          this.gl.deleteTexture(stale.material);
        }
      });
    }

    if (previous.renderDistance !== settings.renderDistance) this.createTintAtlas();

    this.internalWidth = -1;
    this.resize(this.width, this.height);
    this.state.invalidate();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  render(frame: FrameState): void {
    const gl = this.gl;
    if (!this.materials || !this.main) return;

    this.frameIndex++;
    this.stats.drawCalls = 0;
    this.stats.shadowDraws = 0;

    const profiler = this.profiler;
    profiler.beginFrame();

    this.updateMatrices(frame);
    this.updateSceneUniforms(frame);

    this.sky.setCameraHeight(frame.cameraPosition[1]);
    profiler.begin('sky LUT');
    this.sky.renderSkyView();
    profiler.end();

    if (this.settings.shadowsEnabled && this.shadows && this.sky.sunIntensity > 0.001) {
      profiler.begin('shadow maps');
      this.renderShadows(frame);
      profiler.end();
    }

    // No depth prepass. It existed only to produce normals for SSAO, and
    // measurement put its true cost at ~7 ms of GPU plus half of all the draw
    // calls in the frame — for a pass that costs 1.5 ms. SSAO now reconstructs
    // normals from depth and runs at the end of the frame for the next one to
    // consume, and the opaque pass owns depth again.
    this.clearMainDepth();

    this.renderOpaque(frame, true);

    profiler.begin('sky');
    this.renderSky();
    profiler.end();

    if (this.settings.cloudMode !== 'off') {
      profiler.begin('clouds');
      this.renderClouds();
      profiler.end();
    }

    if (this.settings.lightShafts) {
      profiler.begin('shafts');
      this.renderLightShafts();
      profiler.end();
    }

    // The copy exists so a shader can read what is already on screen: the
    // water, to see through itself, and the wet-ground pass, to reflect. It is
    // a full-resolution colour and depth blit, so doing it on frames that need
    // neither is a millisecond thrown away — and in dry weather inland that is
    // most frames.
    const hasWater = this.geometry.list(Bucket.Water).length > 0;
    const wantsWet = this.settings.wetReflections && this.sky.weather.wetness > 0.03;

    if (hasWater || wantsWet) {
      profiler.begin('scene copy');
      this.copyScene();
      profiler.end();
    }

    if (wantsWet) {
      profiler.begin('wet');
      this.renderWetReflections();
      profiler.end();
    }

    if (hasWater) {
      profiler.begin('water');
      this.renderWater(frame);
      profiler.end();
    }

    this.renderTranslucent(frame);

    if (this.sky.weather.rain > 0.02) {
      profiler.begin('weather');
      this.renderWeather();
      profiler.end();
    }
    if (frame.selection) this.renderSelection(frame.selection);

    profiler.begin('taa');
    const resolved = this.settings.taaEnabled ? this.resolveTAA() : this.main.texture;
    profiler.end();

    profiler.begin('exposure');
    const adapted = this.updateExposure(resolved);
    profiler.end();

    profiler.begin('bloom');
    const bloom = this.settings.bloomEnabled ? this.renderBloom(resolved) : null;
    profiler.end();

    profiler.begin('composite');
    this.composite(resolved, bloom, adapted, frame);
    profiler.end();

    // Occlusion for the next frame, from the depth this one just wrote.
    if (this.settings.ssaoEnabled) {
      profiler.begin('ssao');
      this.renderSSAO();
      profiler.end();
    }

    m4copy(this.prevViewProj, this.viewProj);
    this.prevJitterX = this.jitterX;
    this.prevJitterY = this.jitterY;
    this.historyValid = true;

    this.stats.visibleQuads = this.geometry.visibleQuads;
    this.stats.totalQuads = this.geometry.totalQuads;
    this.stats.sections = this.geometry.sectionCount;

    gl.bindVertexArray(null);
  }

  private updateMatrices(frame: FrameState): void {
    const aspect = this.internalWidth / this.internalHeight;
    const near = 0.06;

    m4perspectiveReverseZ(this.proj, this.settings.fovDegrees * DEG2RAD, aspect, near);

    // TAA jitter: a Halton(2,3) sequence over 8 frames. Applied to the
    // projection's translation, which shifts the sample grid by a subpixel
    // amount without changing what the frustum contains.
    if (this.settings.taaEnabled) {
      const index = this.frameIndex % 8;
      this.jitterX = (radicalInverse2(index + 1) - 0.5) * 2 / this.internalWidth;
      this.jitterY = (halton3(index + 1) - 0.5) * 2 / this.internalHeight;
    } else {
      this.jitterX = 0;
      this.jitterY = 0;
    }

    m4copy(this.jitteredProj, this.proj);
    this.jitteredProj[8] += this.jitterX;
    this.jitteredProj[9] += this.jitterY;

    v3set(
      this.scratchTarget,
      frame.cameraPosition[0] + frame.cameraForward[0],
      frame.cameraPosition[1] + frame.cameraForward[1],
      frame.cameraPosition[2] + frame.cameraForward[2],
    );
    m4lookAt(this.view, frame.cameraPosition, this.scratchTarget, frame.cameraUp);

    m4mul(this.viewProj, this.jitteredProj, this.view);
    m4invert(this.invViewProj, this.viewProj);
    this.frustum.setFromMatrix(this.viewProj);

    if (!this.historyValid) m4copy(this.prevViewProj, this.viewProj);

    this.geometry.cull(
      this.frustum,
      frame.cameraPosition[0], frame.cameraPosition[1], frame.cameraPosition[2],
    );
  }

  private updateSceneUniforms(frame: FrameState): void {
    const d = this.sceneData;
    const sky = this.sky;

    d.set(this.viewProj, 0);
    d.set(this.prevViewProj, 16);
    d.set(this.invViewProj, 32);
    d.set(this.view, 48);
    d.set(this.jitteredProj, 64);

    d[80] = frame.cameraPosition[0];
    d[81] = frame.cameraPosition[1];
    d[82] = frame.cameraPosition[2];
    d[83] = frame.time;

    d[84] = sky.sunDirection[0];
    d[85] = sky.sunDirection[1];
    d[86] = sky.sunDirection[2];
    d[87] = sky.sunIntensity;

    d[88] = sky.moonDirection[0];
    d[89] = sky.moonDirection[1];
    d[90] = sky.moonDirection[2];
    d[91] = sky.moonIntensity;

    d[92] = sky.sunColor[0];
    d[93] = sky.sunColor[1];
    d[94] = sky.sunColor[2];
    d[95] = sky.dayFactor;

    d[96] = sky.moonColor[0];
    d[97] = sky.moonColor[1];
    d[98] = sky.moonColor[2];
    d[99] = sky.nightFactor;

    d[100] = this.internalWidth;
    d[101] = this.internalHeight;
    d[102] = 1 / this.internalWidth;
    d[103] = 1 / this.internalHeight;

    d[104] = this.jitterX;
    d[105] = this.jitterY;
    d[106] = this.prevJitterX;
    d[107] = this.prevJitterY;

    // Tuned so a horizontal view at sea level reaches about half opacity at the
    // far edge of the render distance. The height falloff is deliberately
    // gentle: a steep one makes the fog integral explode when looking down from
    // a summit, which whites out the entire valley.
    const viewBlocks = this.settings.renderDistance * CHUNK_SIZE;
    const base = 0.75 / Math.max(viewBlocks, 32);
    d[108] = base * frame.biomeFog * (1 + sky.weather.rain * 2.6);
    d[109] = 0.006;
    d[110] = 6.0;
    d[111] = viewBlocks;

    d[112] = sky.weather.rain;
    d[113] = sky.weather.wetness;
    d[114] = sky.weather.wind;
    d[115] = sky.weather.windAngle;

    d[116] = this.settings.exposure;
    d[117] = 0.06;
    d[118] = this.frameIndex % 4096;
    d[119] = frame.deltaTime;

    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.sceneUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, d);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.pointLightPos.fill(0);
    this.pointLightColor.fill(0);
    const count = Math.min(frame.pointLightCount, MAX_POINT_LIGHTS);
    for (let i = 0; i < count; i++) {
      this.pointLightPos[i * 4] = frame.pointLights[i * 4];
      this.pointLightPos[i * 4 + 1] = frame.pointLights[i * 4 + 1];
      this.pointLightPos[i * 4 + 2] = frame.pointLights[i * 4 + 2];
      // Radius grows with the emitter's light level.
      this.pointLightPos[i * 4 + 3] = 4 + frame.pointLights[i * 4 + 3] * 1.35;

      this.pointLightColor[i * 4] = 1.0;
      this.pointLightColor[i * 4 + 1] = 0.62;
      this.pointLightColor[i * 4 + 2] = 0.3;
      this.pointLightColor[i * 4 + 3] = frame.pointLights[i * 4 + 3] * 0.9;
    }
    this.activePointLights = count;
  }

  private activePointLights = 0;

  // --- shadow pass ---

  private renderShadows(frame: FrameState): void {
    const gl = this.gl;
    const shadows = this.shadows;
    if (!shadows || !this.materials) return;

    const s = this.settings;
    shadows.update(
      frame.cameraPosition, frame.cameraForward,
      s.fovDegrees, this.internalWidth / this.internalHeight,
      0.1, s.shadowDistance, this.sky.sunDirection,
      this.frameIndex,
    );

    this.state.setDepthTest(true);
    this.state.setDepthWrite(true);
    this.state.setDepthFunc(gl.GEQUAL);
    this.state.setBlend(false);
    // Back-face culling, not front.
    //
    // Front-face culling is the standard trick for closed solids: it stores the
    // far side of each object and gives the bias for free. A greedy-meshed
    // voxel world is not a closed solid — it is a shell with no interior faces,
    // so culling front faces threw away exactly the surfaces that cast shadows
    // and left the shadow map holding only the sides of blocks. Flat ground
    // then tested against those side depths and self-shadowed in hard
    // half-quad triangles. The normal-offset bias in lib/shadow.glsl is what
    // keeps this configuration free of acne.
    this.state.setCull(true, gl.BACK);

    const solid = this.programs.get('chunk.shadow');
    const cutout = this.programs.get('chunk.shadow.cutout');

    for (let cascade = 0; cascade < shadows.count; cascade++) {
      const info = shadows.cascades[cascade];
      // Skipped cascades keep last frame's depth, which is still valid because
      // their matrix was not refitted either.
      if (!info.dirty) continue;

      shadows.beginCascade(cascade);
      this.state.invalidate();

      for (const pass of [0, 1]) {
        const program = pass === 0 ? solid : cutout;
        // Glass and ice are skipped as casters: their shadow is negligible and
        // they are a meaningful share of the geometry in a built-up area.
        const buckets = pass === 0 ? [Bucket.Opaque] : [Bucket.Cutout];

        this.geometry.cullForShadow(info.frustum, this.shadowList, buckets);
        if (this.shadowList.length === 0) continue;

        this.state.useProgram(program.handle);
        program.mat4('uLightViewProj', info.matrix);
        program.vec2('uTintParams', 1 / this.tintAtlasSize, this.tintAtlasSize);

        if (pass === 1) {
          this.state.bindTexture(0, gl.TEXTURE_2D_ARRAY, this.materials.albedo);
          program.int('uAlbedoArray', 0);
          // Foliage is two-sided and must not be culled at all.
          this.state.setCull(false);
        } else {
          this.state.setCull(true, gl.BACK);
        }

        for (const item of this.shadowList) {
          program.vec3(
            'uChunkOrigin',
            item.section.originX, item.section.originY, item.section.originZ,
          );
          this.state.bindVAO(item.mesh.vao);
          gl.drawElements(gl.TRIANGLES, item.mesh.quadCount * 6, gl.UNSIGNED_INT, 0);
          this.stats.shadowDraws++;
        }
      }
    }

    this.state.setCull(true, gl.BACK);
    this.state.invalidate();
  }

  private drawBucket(program: Program, bucket: Bucket): void {
    const gl = this.gl;
    // Debug view 8 paints each bucket a flat colour, which is the fastest way
    // to find out which pass actually put a pixel on screen.
    if (this.debugView === 8) {
      const c = BUCKET_DEBUG_COLOR[bucket] ?? [1, 1, 1];
      program.vec3('uDebugBucket', c[0], c[1], c[2]);
    }
    for (const item of this.geometry.list(bucket)) {
      program.vec3(
        'uChunkOrigin',
        item.section.originX, item.section.originY, item.section.originZ,
      );
      this.state.bindVAO(item.mesh.vao);
      gl.drawElements(gl.TRIANGLES, item.mesh.quadCount * 6, gl.UNSIGNED_INT, 0);
      this.stats.drawCalls++;
    }
  }

  // --- ambient occlusion ---

  private renderSSAO(): void {
    const gl = this.gl;
    const program = this.programs.get('ssao');
    const target = this.aoTargets[0];

    this.state.setDepthTest(false);
    this.state.setBlend(false);
    this.state.setCull(false);

    this.state.bindFramebuffer(target.fbo);
    this.state.viewport(0, 0, target.width, target.height);
    this.state.useProgram(program.handle);

    this.state.bindTexture(0, gl.TEXTURE_2D, this.main.depthTexture);
    program.int('uSceneDepth', 0);
    program.float('uRadius', 0.85);
    program.float('uIntensity', 1.05);
    program.float('uBias', 0.06);
    this.triangle.draw();

    // Two separable bilateral passes.
    const blur = this.programs.get('bilateral');
    this.state.useProgram(blur.handle);
    blur.int('uSource', 0);
    blur.int('uSceneDepth', 1);
    blur.float('uDepthSigma', 1.4);

    for (let pass = 0; pass < 2; pass++) {
      const source = this.aoTargets[pass];
      const destination = this.aoTargets[1 - pass];
      this.state.bindFramebuffer(destination.fbo);
      this.state.viewport(0, 0, destination.width, destination.height);
      this.state.bindTexture(0, gl.TEXTURE_2D, source.texture);
      this.state.bindTexture(1, gl.TEXTURE_2D, this.main.depthTexture);
      blur.vec2(
        'uDirection',
        pass === 0 ? 1 / destination.width : 0,
        pass === 0 ? 0 : 1 / destination.height,
      );
      this.triangle.draw();
    }
    // After two passes the result is back in aoTargets[0].
  }

  // --- forward shading ---

  private bindChunkCommon(program: Program): void {
    const gl = this.gl;
    if (!this.materials) return;

    this.state.bindTexture(0, gl.TEXTURE_2D_ARRAY, this.materials.albedo);
    this.state.bindTexture(1, gl.TEXTURE_2D_ARRAY, this.materials.surface);
    this.state.bindTexture(2, gl.TEXTURE_2D_ARRAY, this.tintAtlas);
    this.state.bindTexture(3, gl.TEXTURE_2D, this.aoTargets[0].texture);
    this.state.bindTexture(4, gl.TEXTURE_2D, this.sky.skyView.texture);
    this.state.bindTexture(5, gl.TEXTURE_2D, this.sky.transmittance.texture);
    this.state.bindTexture(11, gl.TEXTURE_2D_ARRAY, this.materials.material);
    if (this.shadows) {
      this.state.bindTexture(6, gl.TEXTURE_2D_ARRAY, this.shadows.texture);
    }
    // Unit 12 is the indirect-light grid's, bound or not: a sampler3D left
    // pointing at unit 0 would collide with the 2D array bound there, and the
    // strength is zero until the first bake lands anyway.
    if (this.giVolume) this.state.bindTexture(12, gl.TEXTURE_3D, this.giVolume);
    program.int('uGiVolume', 12);
    // xyz = world-to-grid scale, w = strength. The grid is toroidal, so the
    // texture coordinate is just the world position over the grid's extent and
    // REPEAT does the wrapping.
    program.vec4(
      'uGiParams',
      1 / (GI_SIZE_XZ * GI_CELL),
      1 / (GI_SIZE_Y * GI_CELL),
      1 / (GI_SIZE_XZ * GI_CELL),
      this.giReady ? this.settings.giStrength : 0,
    );

    program.int('uAlbedoArray', 0);
    program.int('uSurfaceArray', 1);
    program.int('uMaterialArray', 11);
    program.int('uTintAtlas', 2);
    program.int('uAmbientOcclusion', 3);
    program.int('uSkyViewLut', 4);
    program.int('uTransmittanceLut', 5);
    program.int('uShadowMap', 6);

    program.float('uTextureSize', this.materials.size);
    program.float('uSurfaceDetail', this.settings.surfaceDetail);
    // Relief depth in blocks, and the reciprocal of the distance it fades over.
    program.vec2(
      'uParallaxParams',
      this.settings.parallaxDepth,
      1 / Math.max(1, this.settings.parallaxDistance),
    );
    program.vec2('uTintParams', 1 / this.tintAtlasSize, this.tintAtlasSize);
    program.float('uCameraRadiusKm', this.sky.cameraRadiusKm);
    program.vec2('uHorizonAngles', this.sky.horizonAngles[0], this.sky.horizonAngles[1]);
    program.float('uSeaLevel', SEA_LEVEL);

    if (this.shadows) {
      program.mat4Array('uShadowMatrices', this.shadows.matrixData);
      program.vec4v('uCascadeSplits', this.shadows.splitData);
      program.vec4v('uCascadeTexel', this.shadows.texelData);
      program.float('uShadowTexel', 1 / this.shadows.size);
      program.int('uCascadeCount', this.shadows.count);
      // Reversed depth over a large ortho range needs only a small constant
      // bias; the normal offset in the shader does the heavy lifting.
      program.vec2('uShadowBias', 0.00006, 0.0004);
    }

    program.int('uDebugView', this.debugView);
    program.vec4Array('uPointLightPos', this.pointLightPos);
    program.vec4Array('uPointLightColor', this.pointLightColor);
    program.int('uPointLightCount', this.activePointLights);
  }

  /** Clears depth when there is no prepass to lay it down. */
  private clearMainDepth(): void {
    const gl = this.gl;
    this.state.bindFramebuffer(this.main.fbo);
    this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.drawBuffers([gl.NONE]);
    this.state.setDepthWrite(true);
    gl.clearDepth(0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  private renderOpaque(frame: FrameState, writeDepth: boolean): void {
    const gl = this.gl;

    this.state.bindFramebuffer(this.main.fbo);
    this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);

    this.state.setDepthTest(true);
    // With a prepass, depth is already correct and writes stay off so early-Z
    // can reject before the shader runs. Without one, this pass owns depth.
    this.state.setDepthWrite(writeDepth);
    this.state.setDepthFunc(gl.GEQUAL);
    this.state.setBlend(false);
    this.state.setCull(true, gl.BACK);

    this.profiler.begin('chunks opaque');
    const opaque = this.programs.get('chunk.opaque');
    this.state.useProgram(opaque.handle);
    this.bindChunkCommon(opaque);
    this.drawBucket(opaque, Bucket.Opaque);
    this.profiler.end();

    this.profiler.begin('chunks cutout');
    const cutout = this.programs.get('chunk.cutout');
    this.state.useProgram(cutout.handle);
    this.bindChunkCommon(cutout);
    this.state.setCull(false);
    this.drawBucket(cutout, Bucket.Cutout);
    this.state.setCull(true, gl.BACK);
    this.profiler.end();

    if (this.settings.grassEnabled) {
      this.profiler.begin('grass');
      this.renderGrass(frame);
      this.profiler.end();
    }
  }

  private renderGrass(_frame: FrameState): void {
    const gl = this.gl;
    const program = this.programs.get('grass');
    const s = this.settings;

    this.state.useProgram(program.handle);
    this.state.setDepthWrite(true);
    this.state.setCull(false);
    // Blades are alpha-faded at the far edge rather than clipped.
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.state.bindTexture(2, gl.TEXTURE_2D_ARRAY, this.tintAtlas);
    this.state.bindTexture(4, gl.TEXTURE_2D, this.sky.skyView.texture);
    this.state.bindTexture(5, gl.TEXTURE_2D, this.sky.transmittance.texture);
    if (this.shadows) this.state.bindTexture(6, gl.TEXTURE_2D_ARRAY, this.shadows.texture);

    program.int('uTintAtlas', 2);
    program.int('uSkyViewLut', 4);
    program.int('uTransmittanceLut', 5);
    program.int('uShadowMap', 6);
    program.vec2('uTintParams', 1 / this.tintAtlasSize, this.tintAtlasSize);
    program.float('uCameraRadiusKm', this.sky.cameraRadiusKm);
    program.vec2('uHorizonAngles', this.sky.horizonAngles[0], this.sky.horizonAngles[1]);
    program.float('uSeaLevel', SEA_LEVEL);
    program.int('uDebugView', this.debugView);
    program.vec3('uDebugBucket', ...GRASS_DEBUG_COLOR);
    program.float('uBladeHeight', 0.42);
    program.float('uBladeWidth', 0.024);
    program.float('uGrassDistance', s.grassDistance);
    program.vec2('uBladeGrow', GRASS_FAR_SCALE[0], GRASS_FAR_SCALE[1]);

    if (this.shadows) {
      program.mat4Array('uShadowMatrices', this.shadows.matrixData);
      program.vec4v('uCascadeSplits', this.shadows.splitData);
      program.vec4v('uCascadeTexel', this.shadows.texelData);
      program.float('uShadowTexel', 1 / this.shadows.size);
      program.int('uCascadeCount', this.shadows.count);
      program.vec2('uShadowBias', 0.00012, 0.0008);
    }

    this.state.bindVAO(this.emptyVao);

    // One draw per ring. The grid is square and anchored to whole blocks, so it
    // has to be wide enough for the ring's outer radius plus a block of margin
    // for the blade's own offset inside its cell.
    let inner = 0;
    for (const [i, ring] of GRASS_RINGS.entries()) {
      const outer = s.grassDistance * ring.outer;
      const blades = Math.max(1, Math.round(ring.blades * s.grassDensity));
      const carry = i + 1 < GRASS_RINGS.length
        ? Math.max(1, Math.round(GRASS_RINGS[i + 1].blades * s.grassDensity))
        : 0;

      // Even, so that half the grid is a whole number of blocks and cells stay
      // anchored to integer world coordinates — that anchoring is what stops
      // blades from swimming as the camera moves.
      const gridSize = 2 * (Math.ceil(outer) + 1);

      program.int('uGridSize', gridSize);
      program.int('uBladesPerCell', blades);
      program.int('uCarryBlades', carry);
      program.vec2('uRingRadii', inner, outer);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 7, gridSize * gridSize * blades);
      this.stats.drawCalls++;

      inner = outer;
    }

    this.state.setBlend(false);
    this.state.setDepthWrite(false);
    this.state.setCull(true, gl.BACK);
  }

  private renderSky(): void {
    const gl = this.gl;
    const program = this.programs.get('sky');

    this.state.useProgram(program.handle);
    this.state.setDepthTest(true);
    this.state.setDepthWrite(false);
    this.state.setDepthFunc(gl.GEQUAL);
    this.state.setBlend(false);
    this.state.setCull(false);

    this.state.bindTexture(4, gl.TEXTURE_2D, this.sky.skyView.texture);
    this.state.bindTexture(5, gl.TEXTURE_2D, this.sky.transmittance.texture);
    program.int('uSkyViewLut', 4);
    program.int('uTransmittanceLut', 5);
    program.float('uCameraRadiusKm', this.sky.cameraRadiusKm);
    program.vec2('uHorizonAngles', this.sky.horizonAngles[0], this.sky.horizonAngles[1]);
    program.float('uSeaLevel', SEA_LEVEL);

    this.state.bindVAO(this.triangle.handle);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
  }

  private renderClouds(): void {
    const gl = this.gl;
    const s = this.settings;

    if (s.cloudMode === 'volumetric' && this.cloudNoise) {
      const program = this.programs.get('clouds');
      this.state.bindFramebuffer(this.cloudTarget.fbo);
      this.state.viewport(0, 0, this.cloudTarget.width, this.cloudTarget.height);
      this.state.setDepthTest(false);
      this.state.setBlend(false);
      this.state.useProgram(program.handle);

      this.state.bindTexture(4, gl.TEXTURE_2D, this.sky.skyView.texture);
      this.state.bindTexture(5, gl.TEXTURE_2D, this.sky.transmittance.texture);
      this.state.bindTexture(9, gl.TEXTURE_3D, this.cloudNoise.shape);
      this.state.bindTexture(10, gl.TEXTURE_3D, this.cloudNoise.detail);
      program.int('uSkyViewLut', 4);
      program.int('uTransmittanceLut', 5);
      program.int('uCloudShape', 9);
      program.int('uCloudDetail', 10);
      program.float('uCameraRadiusKm', this.sky.cameraRadiusKm);
    program.vec2('uHorizonAngles', this.sky.horizonAngles[0], this.sky.horizonAngles[1]);
      program.float('uSeaLevel', SEA_LEVEL);
      program.float('uCloudBottom', 320);
      program.float('uCloudTop', 620);
      program.float('uCloudCoverage', 0.6);
      program.float('uCloudDensity', 1.2);
      program.float('uCloudSpeed', 5.5);

      this.state.bindVAO(this.triangle.handle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Composite over the sky.
      const composite = this.programs.get('clouds.composite');
      this.state.bindFramebuffer(this.main.fbo);
      this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
      this.state.useProgram(composite.handle);
      this.state.setBlend(true, gl.ONE, gl.SRC_ALPHA);
      // Same far-plane depth test the sky pass uses, so clouds appear only
      // where no geometry was drawn. Sampling the depth buffer here instead
      // would be a read of the framebuffer's own attachment.
      this.state.setDepthTest(true);
      this.state.setDepthWrite(false);
      this.state.setDepthFunc(gl.GEQUAL);

      this.state.bindTexture(0, gl.TEXTURE_2D, this.cloudTarget.texture);
      composite.int('uClouds', 0);
      composite.vec2('uCloudTexel', 1 / this.cloudTarget.width, 1 / this.cloudTarget.height);

      this.state.bindVAO(this.triangle.handle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.state.setBlend(false);
      this.stats.drawCalls += 2;
    }
  }

  /** Copies colour and depth so the water pass can read the scene behind it. */
  private copyScene(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.main.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copy.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.blitFramebuffer(
      0, 0, this.internalWidth, this.internalHeight,
      0, 0, this.internalWidth, this.internalHeight,
      gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.state.invalidate();
  }

  private renderWater(_frame: FrameState): void {
    const gl = this.gl;
    const list = this.geometry.list(Bucket.Water);
    if (list.length === 0) return;

    const program = this.programs.get('water');

    this.state.bindFramebuffer(this.main.fbo);
    this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    this.state.setDepthTest(true);
    this.state.setDepthWrite(true);
    this.state.setDepthFunc(gl.GEQUAL);
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.state.setCull(false);

    // Nudge water away from the camera in depth, so that wherever it ends up
    // coplanar with a block face the solid surface wins deterministically
    // instead of the two trading pixels triangle by triangle.
    //
    // Depth is reversed — nearer is a *larger* value — so the offset is
    // negative. The slope factor is zero, and that is the point: it used to be
    // -1, and a water plane seen edge-on has a depth slope of thousands, so out
    // near the horizon the offset stopped being a nudge and shoved the surface
    // clean through the sea floor. What showed through the hole was sand, drawn
    // as the thin bright wires that ran across the sea to the vanishing point.
    //
    // A constant is enough here. The mesher already drops the water surface a
    // quarter of a block below the block top, so exact coplanarity with the
    // shore never actually happens; this only has to break ties.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0.0, -4.0);

    this.state.useProgram(program.handle);
    this.bindChunkCommon(program);
    this.state.bindTexture(7, gl.TEXTURE_2D, this.copy.texture);
    this.state.bindTexture(8, gl.TEXTURE_2D, this.copy.depthTexture);
    program.int('uSceneColor', 7);
    program.int('uSceneDepth', 8);
    program.float('uWaveAmplitude', 0.085);
    program.int('uWaveCount', this.settings.ssrSteps > 0 ? 5 : 3);
    // Where the vertex displacement fades out. Past this the surface is a flat
    // plane with a per-pixel wave normal on it, which is both what distant
    // water looks like and the only way to keep two levels of detail from
    // tearing apart along their shared edge.
    program.vec2('uWaveFade', 48, 96);
    program.int('uSsrSteps', this.settings.waterReflections ? this.settings.ssrSteps : 0);
    program.float('uSsrDistance', 52);
    program.float('uRefractionStrength', this.settings.waterRefraction ? 1.0 : 0.0);

    this.drawBucket(program, Bucket.Water);

    gl.disable(gl.POLYGON_OFFSET_FILL);
    this.state.setBlend(false);
    this.state.setDepthWrite(false);
    this.state.setCull(true, gl.BACK);
  }

  /**
   * Volumetric light shafts.
   *
   * Two passes, and the split is forced rather than chosen: the march reads the
   * scene depth, which is attached to the main framebuffer, and a shader may
   * not read a texture bound to its own target. So the march renders into its
   * own quarter-size target and a second pass adds it back.
   */
  private renderLightShafts(): void {
    const gl = this.gl;

    // --- march ---
    const march = this.programs.get('shafts');
    this.state.bindFramebuffer(this.shaftTarget.fbo);
    this.state.viewport(0, 0, this.shaftTarget.width, this.shaftTarget.height);
    this.state.setDepthTest(false);
    this.state.setDepthWrite(false);
    this.state.setCull(false);
    this.state.setBlend(false);

    this.state.useProgram(march.handle);
    this.state.bindTexture(0, gl.TEXTURE_2D, this.main.depthTexture);
    if (this.shadows) this.state.bindTexture(6, gl.TEXTURE_2D_ARRAY, this.shadows.texture);
    march.int('uSceneDepth', 0);
    march.int('uShadowMap', 6);
    march.float('uRange', Math.min(this.settings.shadowDistance, 140));
    march.float('uStrength', this.settings.lightShaftStrength);
    march.float('uSeaLevel', SEA_LEVEL);
    if (this.shadows) {
      march.mat4Array('uShadowMatrices', this.shadows.matrixData);
      march.vec4v('uCascadeSplits', this.shadows.splitData);
      march.vec4v('uCascadeTexel', this.shadows.texelData);
      march.float('uShadowTexel', 1 / this.shadows.size);
      march.int('uCascadeCount', this.shadows.count);
      march.vec2('uShadowBias', 0.00006, 0.0004);
    }
    this.triangle.draw();

    // --- add back ---
    const add = this.programs.get('shafts.add');
    this.state.bindFramebuffer(this.main.fbo);
    this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this.state.setBlend(true, gl.ONE, gl.ONE);
    this.state.useProgram(add.handle);
    this.state.bindTexture(0, gl.TEXTURE_2D, this.shaftTarget.texture);
    add.int('uShafts', 0);
    this.triangle.draw();
    this.state.setBlend(false);
  }

  /**
   * Reflections on wet ground.
   *
   * Runs between the copy and the water: the copy is what it reflects, and the
   * water is drawn afterwards so a puddle never tries to reflect the sea it is
   * standing next to. Blended rather than added — a wet surface turns into a
   * mirror, it does not glow.
   */
  private renderWetReflections(): void {
    const gl = this.gl;
    const program = this.programs.get('wet');

    this.state.bindFramebuffer(this.main.fbo);
    this.state.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Depth is only read, through the copy; the pass covers the screen and
    // decides per pixel whether there is anything wet there.
    this.state.setDepthTest(false);
    this.state.setDepthWrite(false);
    this.state.setCull(false);
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.state.useProgram(program.handle);
    this.state.bindTexture(7, gl.TEXTURE_2D, this.copy.texture);
    this.state.bindTexture(8, gl.TEXTURE_2D, this.copy.depthTexture);
    program.int('uSceneColor', 7);
    program.int('uSceneDepth', 8);
    // Half the water's budget: the ray leaves a puddle at a shallow angle and
    // finds its neighbour quickly, or finds nothing worth showing.
    program.int('uSsrSteps', Math.max(6, Math.round(this.settings.ssrSteps * 0.6)));
    program.float('uWetDistance', 44);

    this.triangle.draw();

    this.state.setBlend(false);
  }

  private renderTranslucent(_frame: FrameState): void {
    const gl = this.gl;
    const list = this.geometry.list(Bucket.Translucent);
    if (list.length === 0) return;

    const program = this.programs.get('chunk.translucent');
    this.state.useProgram(program.handle);
    this.bindChunkCommon(program);

    this.state.setDepthTest(true);
    this.state.setDepthWrite(false);
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawBucket(program, Bucket.Translucent);
    this.state.setBlend(false);
  }

  private renderWeather(): void {
    const gl = this.gl;
    const program = this.programs.get('rain');
    const snow = this.sky.weather.snow;

    const count = Math.round(2600 * this.sky.weather.rain * (this.settings.renderDistance / 8));

    this.state.useProgram(program.handle);
    this.state.setDepthTest(true);
    this.state.setDepthWrite(false);
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE);
    this.state.setCull(false);

    this.state.bindTexture(2, gl.TEXTURE_2D_ARRAY, this.tintAtlas);
    this.state.bindTexture(4, gl.TEXTURE_2D, this.sky.skyView.texture);
    this.state.bindTexture(5, gl.TEXTURE_2D, this.sky.transmittance.texture);
    program.int('uTintAtlas', 2);
    program.int('uSkyViewLut', 4);
    program.int('uTransmittanceLut', 5);
    program.vec2('uTintParams', 1 / this.tintAtlasSize, this.tintAtlasSize);
    program.float('uCameraRadiusKm', this.sky.cameraRadiusKm);
    program.vec2('uHorizonAngles', this.sky.horizonAngles[0], this.sky.horizonAngles[1]);
    program.float('uSeaLevel', SEA_LEVEL);
    program.float('uRadius', 26);
    program.float('uHeight', 34);
    program.float('uFallSpeed', snow > 0.5 ? 3.2 : 24);
    program.float('uSnow', snow);
    program.float('uParticleSize', snow > 0.5 ? 0.09 : 0.075);

    this.state.bindVAO(this.emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    this.stats.drawCalls++;

    this.state.setBlend(false);
  }

  private renderSelection(selection: { x: number; y: number; z: number }): void {
    const gl = this.gl;
    const program = this.programs.get('selection');

    this.state.useProgram(program.handle);
    this.state.setDepthTest(true);
    this.state.setDepthWrite(false);
    this.state.setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.state.setCull(false);

    program.vec3('uBlockPos', selection.x, selection.y, selection.z);
    program.float('uInflate', 0.006);
    program.vec4('uColor', 0.02, 0.02, 0.03, 0.65);

    this.state.bindVAO(this.emptyVao);
    gl.drawArrays(gl.LINES, 0, 24);
    this.stats.drawCalls++;

    this.state.setBlend(false);
  }

  // --- post ---

  private resolveTAA(): WebGLTexture {
    const gl = this.gl;
    const program = this.programs.get('taa');

    const current = this.taaTargets[this.historyIndex];
    const history = this.taaTargets[1 - this.historyIndex];

    this.state.bindFramebuffer(current.fbo);
    this.state.viewport(0, 0, current.width, current.height);
    this.state.setDepthTest(false);
    this.state.setBlend(false);
    this.state.setCull(false);
    this.state.useProgram(program.handle);

    this.state.bindTexture(0, gl.TEXTURE_2D, this.main.texture);
    this.state.bindTexture(1, gl.TEXTURE_2D, this.historyValid ? history.texture : this.main.texture);
    this.state.bindTexture(2, gl.TEXTURE_2D, this.main.depthTexture);
    program.int('uCurrent', 0);
    program.int('uHistory', 1);
    program.int('uSceneDepth', 2);
    program.float('uFeedback', this.historyValid ? 0.12 : 1.0);

    this.state.bindVAO(this.triangle.handle);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;

    this.historyIndex = 1 - this.historyIndex;
    return current.texture;
  }

  /**
   * Measures the frame's average log luminance and eases the adapted value
   * toward it. Returns the 1x1 texture the composite pass samples.
   */
  private updateExposure(source: WebGLTexture): WebGLTexture {
    const gl = this.gl;

    this.state.setDepthTest(false);
    this.state.setBlend(false);
    this.state.setCull(false);
    this.state.bindVAO(this.triangle.handle);

    const init = this.programs.get('luminance');
    const first = this.luminanceTargets[0];
    this.state.bindFramebuffer(first.fbo);
    this.state.viewport(0, 0, first.width, first.height);
    this.state.useProgram(init.handle);
    this.state.bindTexture(0, gl.TEXTURE_2D, source);
    init.int('uScene', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const reduce = this.programs.get('luminance.reduce');
    this.state.useProgram(reduce.handle);
    reduce.int('uSource', 0);

    for (let i = 1; i < this.luminanceTargets.length; i++) {
      const from = this.luminanceTargets[i - 1];
      const to = this.luminanceTargets[i];
      this.state.bindFramebuffer(to.fbo);
      this.state.viewport(0, 0, to.width, to.height);
      this.state.bindTexture(0, gl.TEXTURE_2D, from.texture);
      reduce.vec2('uTexel', 1 / from.width, 1 / from.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const average = this.luminanceTargets[this.luminanceTargets.length - 1];
    const current = this.adaptationTargets[this.adaptationIndex];
    const previous = this.adaptationTargets[1 - this.adaptationIndex];

    const adapt = this.programs.get('adaptation');
    this.state.bindFramebuffer(current.fbo);
    this.state.viewport(0, 0, 1, 1);
    this.state.useProgram(adapt.handle);
    this.state.bindTexture(0, gl.TEXTURE_2D, average.texture);
    this.state.bindTexture(1, gl.TEXTURE_2D, previous.texture);
    adapt.int('uCurrent', 0);
    adapt.int('uPrevious', 1);
    // Darkening is fast, brightening is slow — matching how eyes behave.
    adapt.vec2('uSpeed', 2.6, 0.75);
    // The lower bound is what keeps night looking like night: below it the eye
    // stops compensating and the frame genuinely darkens, rather than auto
    // exposure turning midnight into an overcast afternoon.
    adapt.vec2('uRange', 0.0011, 40.0);
    adapt.float('uReset', this.adaptationValid ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.adaptationIndex = 1 - this.adaptationIndex;
    this.adaptationValid = true;
    this.stats.drawCalls += this.luminanceTargets.length + 1;

    return current.texture;
  }

  private renderBloom(source: WebGLTexture): WebGLTexture {
    const gl = this.gl;
    const down = this.programs.get('bloom.down');
    const up = this.programs.get('bloom.up');

    this.state.setDepthTest(false);
    this.state.setCull(false);
    this.state.setBlend(false);
    this.state.useProgram(down.handle);
    down.int('uSource', 0);
    down.float('uThreshold', 1.1);
    down.float('uSoftKnee', 0.6);

    let input = source;
    let inputWidth = this.internalWidth;
    let inputHeight = this.internalHeight;

    for (let i = 0; i < this.bloomTargets.length; i++) {
      const target = this.bloomTargets[i];
      this.state.bindFramebuffer(target.fbo);
      this.state.viewport(0, 0, target.width, target.height);
      this.state.bindTexture(0, gl.TEXTURE_2D, input);
      down.vec2('uTexel', 1 / inputWidth, 1 / inputHeight);
      down.float('uKarisAverage', i === 0 ? 1 : 0);
      this.state.bindVAO(this.triangle.handle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      input = target.texture;
      inputWidth = target.width;
      inputHeight = target.height;
    }

    this.state.useProgram(up.handle);
    up.int('uSource', 0);
    up.float('uRadius', 1.2);
    this.state.setBlend(true, gl.ONE, gl.ONE);

    for (let i = this.bloomTargets.length - 1; i > 0; i--) {
      const source2 = this.bloomTargets[i];
      const target = this.bloomTargets[i - 1];
      this.state.bindFramebuffer(target.fbo);
      this.state.viewport(0, 0, target.width, target.height);
      this.state.bindTexture(0, gl.TEXTURE_2D, source2.texture);
      up.vec2('uTexel', 1 / source2.width, 1 / source2.height);
      this.state.bindVAO(this.triangle.handle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    this.state.setBlend(false);
    this.stats.drawCalls += this.bloomTargets.length * 2 - 1;
    return this.bloomTargets[0].texture;
  }

  private composite(
    scene: WebGLTexture,
    bloom: WebGLTexture | null,
    adapted: WebGLTexture,
    frame: FrameState,
  ): void {
    const gl = this.gl;
    const program = this.programs.get('composite');
    const s = this.settings;

    this.state.bindFramebuffer(null);
    this.state.viewport(0, 0, this.width, this.height);
    this.state.setDepthTest(false);
    this.state.setBlend(false);
    this.state.setCull(false);
    this.state.useProgram(program.handle);

    this.state.bindTexture(0, gl.TEXTURE_2D, scene);
    this.state.bindTexture(1, gl.TEXTURE_2D, bloom ?? scene);
    this.state.bindTexture(2, gl.TEXTURE_2D, this.main.depthTexture);
    this.state.bindTexture(3, gl.TEXTURE_2D, adapted);
    program.int('uScene', 0);
    program.int('uBloom', 1);
    program.int('uSceneDepth', 2);
    program.int('uAdaptedLuminance', 3);

    // Middle grey. Lower values give a darker, more filmic image; this sits
    // slightly under the classic 0.18 because the ACES curve already lifts the
    // midtones.
    program.float('uExposureKey', 0.16);
    program.vec2('uExposureLimits', 0.02, 160.0);

    program.float('uBloomStrength', bloom ? s.bloomStrength : 0);
    // The vignette closes in as breath runs out. Nothing else in the frame says
    // the player is in trouble — there is no health bar to drain — so the frame
    // itself has to, and darkening the edges of vision is what running out of
    // air actually feels like.
    program.float('uVignette', s.vignette + (1 - frame.breath) * 0.85);
    program.float('uChromaticAberration', s.chromaticAberration);
    program.float('uFilmGrain', s.filmGrain);
    program.float('uContrast', 1.06);
    program.float('uSaturation', 1.06);

    if (frame.underwater) {
      program.vec4(
        'uUnderwater',
        frame.underwaterTint[0], frame.underwaterTint[1], frame.underwaterTint[2], 1,
      );
      program.float('uUnderwaterDepth', frame.underwaterDepth);
    } else {
      program.vec4('uUnderwater', 0, 0, 0, 0);
      program.float('uUnderwaterDepth', 0);
    }

    this.state.bindVAO(this.triangle.handle);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
  }

  dispose(): void {
    this.geometry.dispose();
    this.sky.dispose();
    this.shadows?.dispose();
    this.programs.dispose();
    this.triangle.dispose();
    this.main?.dispose();
    this.copy?.dispose();
    for (const t of this.aoTargets) t.dispose();
    for (const t of this.taaTargets) t.dispose();
    for (const t of this.bloomTargets) t.dispose();
    for (const t of this.luminanceTargets) t.dispose();
    for (const t of this.adaptationTargets) t.dispose();
    this.cloudTarget?.dispose();
    this.shaftTarget?.dispose();
    if (this.tintAtlas) this.gl.deleteTexture(this.tintAtlas);
    if (this.materials) {
      this.gl.deleteTexture(this.materials.albedo);
      this.gl.deleteTexture(this.materials.surface);
      this.gl.deleteTexture(this.materials.material);
    }
    if (this.cloudNoise) {
      this.gl.deleteTexture(this.cloudNoise.shape);
      this.gl.deleteTexture(this.cloudNoise.detail);
    }
    this.gl.deleteVertexArray(this.emptyVao);
    this.gl.deleteBuffer(this.sceneUbo);
  }
}

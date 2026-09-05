/**
 * WebGL2 context creation, capability probing and a thin redundant-state filter.
 *
 * The state cache matters more here than on a desktop GPU: the Intel driver's
 * validation cost per GL call is high enough that filtering redundant binds is
 * worth a few percent of frame time in a scene with hundreds of chunk draws.
 */

export interface GLCaps {
  /** EXT_color_buffer_float — required for the HDR pipeline. */
  colorBufferFloat: boolean;
  /** EXT_color_buffer_half_float — the cheaper HDR path, preferred on iGPUs. */
  colorBufferHalfFloat: boolean;
  /** OES_texture_float_linear — bilinear filtering of 32-bit float textures. */
  textureFloatLinear: boolean;
  /** EXT_texture_filter_anisotropic. */
  anisotropic: boolean;
  maxAnisotropy: number;
  /** EXT_disjoint_timer_query_webgl2 — GPU timings in the F3 overlay. */
  timerQuery: boolean;
  /** KHR_parallel_shader_compile — lets us compile the whole set concurrently. */
  parallelShaderCompile: boolean;
  maxTextureSize: number;
  maxArrayTextureLayers: number;
  max3DTextureSize: number;
  maxColorAttachments: number;
  maxSamples: number;
  maxUniformBufferBindings: number;
  uniformBufferOffsetAlignment: number;
  vendor: string;
  renderer: string;
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  caps: GLCaps;
  canvas: HTMLCanvasElement;
}

export class WebGL2UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGL2UnavailableError';
  }
}

export function createContext(canvas: HTMLCanvasElement): GLContext {
  const attribs: WebGLContextAttributes = {
    alpha: false,
    // We own depth entirely inside offscreen targets; the default framebuffer
    // only ever receives a fullscreen blit.
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: true,
    failIfMajorPerformanceCaveat: false,
  };

  const gl = canvas.getContext('webgl2', attribs);
  if (!gl) {
    throw new WebGL2UnavailableError(
      'WebGL2 недоступен. Обнови драйвер видеокарты или включи аппаратное ускорение в браузере.',
    );
  }

  const has = (name: string): boolean => gl.getExtension(name) !== null;

  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

  const caps: GLCaps = {
    colorBufferFloat: has('EXT_color_buffer_float'),
    colorBufferHalfFloat: has('EXT_color_buffer_half_float') || has('EXT_color_buffer_float'),
    textureFloatLinear: has('OES_texture_float_linear'),
    anisotropic: anisoExt !== null,
    maxAnisotropy: anisoExt
      ? (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : 1,
    timerQuery: has('EXT_disjoint_timer_query_webgl2'),
    parallelShaderCompile: has('KHR_parallel_shader_compile'),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
    maxUniformBufferBindings: gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) as number,
    uniformBufferOffsetAlignment: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number,
    vendor: debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string)
      : (gl.getParameter(gl.VENDOR) as string),
    renderer: debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string),
  };

  if (!caps.colorBufferHalfFloat) {
    throw new WebGL2UnavailableError(
      'Драйвер не поддерживает рендер в float-текстуры (EXT_color_buffer_half_float). ' +
        'HDR-пайплайн работать не сможет.',
    );
  }

  return { gl, caps, canvas };
}

/**
 * Redundant-call filter for the handful of state bits this renderer toggles
 * per draw. Anything not tracked here is set directly on the context.
 */
export class GLState {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private activeUnit = -1;
  private readonly boundTextures: Array<{ target: number; tex: WebGLTexture | null }> = [];

  private depthTest = false;
  private depthWrite = true;
  private depthFunc = 0;
  private cullFace = false;
  private cullMode = 0;
  private blend = false;
  private blendSrc = 0;
  private blendDst = 0;
  private colorMaskR = true;

  private viewportX = -1;
  private viewportY = -1;
  private viewportW = -1;
  private viewportH = -1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.depthFunc = gl.LESS;
    this.cullMode = gl.BACK;
    this.blendSrc = gl.ONE;
    this.blendDst = gl.ZERO;
    const units = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    for (let i = 0; i < units; i++) this.boundTextures.push({ target: 0, tex: null });
  }

  useProgram(p: WebGLProgram | null): void {
    if (this.program === p) return;
    this.program = p;
    this.gl.useProgram(p);
  }

  bindVAO(v: WebGLVertexArrayObject | null): void {
    if (this.vao === v) return;
    this.vao = v;
    this.gl.bindVertexArray(v);
  }

  bindFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.framebuffer === fb) return;
    this.framebuffer = fb;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
  }

  bindTexture(unit: number, target: number, tex: WebGLTexture | null): void {
    const slot = this.boundTextures[unit];
    if (slot && slot.tex === tex && slot.target === target) return;
    if (this.activeUnit !== unit) {
      this.activeUnit = unit;
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    }
    this.gl.bindTexture(target, tex);
    if (slot) {
      slot.tex = tex;
      slot.target = target;
    }
  }

  setDepthTest(on: boolean): void {
    if (this.depthTest === on) return;
    this.depthTest = on;
    if (on) this.gl.enable(this.gl.DEPTH_TEST);
    else this.gl.disable(this.gl.DEPTH_TEST);
  }

  setDepthWrite(on: boolean): void {
    if (this.depthWrite === on) return;
    this.depthWrite = on;
    this.gl.depthMask(on);
  }

  setDepthFunc(func: number): void {
    if (this.depthFunc === func) return;
    this.depthFunc = func;
    this.gl.depthFunc(func);
  }

  setCull(on: boolean, mode?: number): void {
    if (this.cullFace !== on) {
      this.cullFace = on;
      if (on) this.gl.enable(this.gl.CULL_FACE);
      else this.gl.disable(this.gl.CULL_FACE);
    }
    if (mode !== undefined && this.cullMode !== mode) {
      this.cullMode = mode;
      this.gl.cullFace(mode);
    }
  }

  setBlend(on: boolean, src?: number, dst?: number): void {
    if (this.blend !== on) {
      this.blend = on;
      if (on) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
    }
    if (src !== undefined && dst !== undefined && (this.blendSrc !== src || this.blendDst !== dst)) {
      this.blendSrc = src;
      this.blendDst = dst;
      this.gl.blendFunc(src, dst);
    }
  }

  setColorMask(on: boolean): void {
    if (this.colorMaskR === on) return;
    this.colorMaskR = on;
    this.gl.colorMask(on, on, on, on);
  }

  viewport(x: number, y: number, w: number, h: number): void {
    if (this.viewportX === x && this.viewportY === y && this.viewportW === w && this.viewportH === h) {
      return;
    }
    this.viewportX = x;
    this.viewportY = y;
    this.viewportW = w;
    this.viewportH = h;
    this.gl.viewport(x, y, w, h);
  }

  /**
   * Drop every cached bit. Call after any code path that touches GL directly
   * (extension calls, external libraries) so the cache cannot go stale.
   */
  invalidate(): void {
    this.program = null;
    this.vao = null;
    this.framebuffer = null;
    this.activeUnit = -1;
    for (const slot of this.boundTextures) {
      slot.tex = null;
      slot.target = 0;
    }
    this.viewportX = this.viewportY = this.viewportW = this.viewportH = -1;
  }
}

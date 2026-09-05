/**
 * Render targets and the fullscreen-triangle helper.
 *
 * Formats are chosen for bandwidth first: on a UHD 620 the framebuffer traffic
 * is the budget, so the HDR chain uses R11F_G11F_B10F (32 bpp) wherever the
 * missing alpha and the 5-bit mantissa are acceptable, and RGBA16F only where
 * TAA history precision demands it.
 */

export interface AttachmentSpec {
  /** Sized internal format, e.g. gl.RGBA16F. */
  internalFormat: number;
  format: number;
  type: number;
  filter?: number;
  wrap?: number;
}

export interface RenderTargetOptions {
  color: AttachmentSpec[];
  /** Attach a sampleable depth texture. */
  depth?: boolean;
  depthFormat?: number;
  /** Sample depth through a comparison sampler (shadow maps). */
  depthCompare?: boolean;
  label?: string;
}

export class RenderTarget {
  readonly fbo: WebGLFramebuffer;
  readonly textures: WebGLTexture[] = [];
  depthTexture: WebGLTexture | null = null;
  width = 0;
  height = 0;

  private readonly drawBuffers: number[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly options: RenderTargetOptions,
    width: number,
    height: number,
  ) {
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error(`Не удалось создать FBO: ${options.label ?? 'unnamed'}`);
    this.fbo = fbo;

    for (let i = 0; i < options.color.length; i++) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Не удалось создать текстуру вложения');
      this.textures.push(tex);
      this.drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
    }

    if (options.depth) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Не удалось создать текстуру глубины');
      this.depthTexture = tex;
    }

    this.resize(width, height);
  }

  get texture(): WebGLTexture {
    return this.textures[0];
  }

  resize(width: number, height: number): boolean {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return false;

    const gl = this.gl;
    this.width = width;
    this.height = height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    for (let i = 0; i < this.options.color.length; i++) {
      const spec = this.options.color[i];
      const tex = this.textures[i];
      const filter = spec.filter ?? gl.LINEAR;
      const wrap = spec.wrap ?? gl.CLAMP_TO_EDGE;

      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, spec.internalFormat, width, height, 0,
        spec.format, spec.type, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0,
      );
    }

    if (this.depthTexture) {
      const internal = this.options.depthFormat ?? gl.DEPTH_COMPONENT32F;
      const type = internal === gl.DEPTH_COMPONENT16 ? gl.UNSIGNED_SHORT : gl.FLOAT;
      gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, internal, width, height, 0,
        gl.DEPTH_COMPONENT, type, null,
      );
      // Shadow maps need LINEAR to get free 2x2 PCF out of the comparison
      // sampler; a depth buffer we read numerically must stay NEAREST.
      const depthFilter = this.options.depthCompare ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, depthFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, depthFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.options.depthCompare) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.GEQUAL);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      }
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTexture, 0,
      );
    }

    if (this.drawBuffers.length > 0) {
      gl.drawBuffers(this.drawBuffers);
    } else {
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `FBO «${this.options.label ?? 'unnamed'}» неполон: 0x${status.toString(16)} ` +
          `(${width}x${height})`,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    for (const tex of this.textures) gl.deleteTexture(tex);
    if (this.depthTexture) gl.deleteTexture(this.depthTexture);
    this.textures.length = 0;
    this.depthTexture = null;
  }
}

/**
 * A single oversized triangle covering the viewport.
 *
 * Preferred over two triangles: no diagonal seam, and the GPU rasterises one
 * primitive instead of two, which also avoids the quad-overdraw along the
 * shared edge. The vertex shader derives position and UV from gl_VertexID, so
 * no vertex buffer is bound at all.
 */
export class FullscreenTriangle {
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Не удалось создать VAO для fullscreen-треугольника');
    this.vao = vao;
  }

  draw(): void {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  get handle(): WebGLVertexArrayObject {
    return this.vao;
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
  }
}

/** Convenience constructors for the formats this renderer uses. */
export function formats(gl: WebGL2RenderingContext) {
  return {
    /** 32 bpp HDR. No alpha, ~5-bit mantissa — fine for bloom and clouds. */
    hdrCompact: {
      internalFormat: gl.R11F_G11F_B10F,
      format: gl.RGB,
      type: gl.HALF_FLOAT,
    } satisfies AttachmentSpec,
    /** 64 bpp HDR with alpha. Used for scene colour and TAA history. */
    hdr: {
      internalFormat: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
    } satisfies AttachmentSpec,
    /** Packed octahedral normal (RG) + roughness (B) + material id (A). */
    normalRough: {
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      filter: gl.NEAREST,
    } satisfies AttachmentSpec,
    /** Screen-space motion vectors for TAA and motion blur. */
    velocity: {
      internalFormat: gl.RG16F,
      format: gl.RG,
      type: gl.HALF_FLOAT,
      filter: gl.NEAREST,
    } satisfies AttachmentSpec,
    /** Single-channel ambient occlusion. */
    ao: {
      internalFormat: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
    } satisfies AttachmentSpec,
    ldr: {
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    } satisfies AttachmentSpec,
    /** Single-channel float, for the log-luminance reduction chain. */
    luminance: {
      internalFormat: gl.R16F,
      format: gl.RED,
      type: gl.HALF_FLOAT,
    } satisfies AttachmentSpec,
  };
}

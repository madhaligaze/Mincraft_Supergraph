/**
 * Cascaded shadow maps.
 *
 * Cascades are fitted to bounding *spheres* of each frustum slice rather than
 * to the slice's bounding box. A sphere is invariant to camera rotation, so the
 * projection stops changing size as the player looks around — combined with
 * snapping the centre to whole shadow texels, that removes the crawling edges
 * that otherwise make voxel shadows unusable at these resolutions.
 */

import {
  Mat4, mat4, m4ortho, m4lookAt, m4mul, m4identity, m4transformPoint,
  Vec3, vec3, v3set, v3normalize, v3cross, v3addScaled, v3copy,
  Frustum, DEG2RAD,
} from '../core/math.ts';

export interface CascadeInfo {
  /** World -> light clip. */
  matrix: Mat4;
  /** Far view distance of this cascade. */
  split: number;
  /** Culling frustum for the cascade's light projection. */
  frustum: Frustum;
  /** World-space size of one shadow texel, for the normal-offset bias. */
  texelWorldSize: number;
  /** True when this cascade was refitted this frame and must be redrawn. */
  dirty: boolean;
}

/**
 * How often each cascade is refitted and redrawn, in frames.
 *
 * Distant cascades cover a large area and barely change from frame to frame, so
 * redrawing them every frame is close to pure waste — and on a vertex-bound
 * integrated GPU the shadow passes were the largest single cost. Staggering
 * them cuts that roughly in half. Cascade 0 stays every-frame because it holds
 * the contact shadows the eye actually tracks.
 */
const CASCADE_INTERVAL = [1, 2, 4, 4];

export class ShadowMaps {
  readonly texture: WebGLTexture;
  readonly cascades: CascadeInfo[] = [];
  /** Flat array of cascade matrices, ready to upload. */
  readonly matrixData: Float32Array;
  readonly splitData = new Float32Array(4);

  private readonly fbo: WebGLFramebuffer;
  private readonly scratch = {
    center: vec3(),
    lightPos: vec3(),
    up: vec3(0, 1, 0),
    right: vec3(),
    forward: vec3(),
    camUp: vec3(),
    corner: vec3(),
    view: mat4(),
    proj: mat4(),
    inverseView: mat4(),
    snapped: vec3(),
  };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly size: number,
    readonly count: number,
  ) {
    const texture = gl.createTexture();
    if (!texture) throw new Error('Не удалось создать массив теневых карт');
    this.texture = texture;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT32F, size, size, count);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Comparison sampling gives free 2x2 PCF out of the LINEAR filter. Depth is
    // reversed, so a lit receiver compares GEQUAL against the occluder.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.GEQUAL);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Не удалось создать FBO теней');
    this.fbo = fbo;

    this.matrixData = new Float32Array(16 * 4);
    for (let i = 0; i < count; i++) {
      this.cascades.push({
        matrix: mat4(),
        split: 0,
        frustum: new Frustum(),
        texelWorldSize: 1,
        dirty: true,
      });
    }
    // Unused cascade slots still need a valid matrix in the uniform array.
    for (let i = 0; i < 4; i++) {
      if (i < count) continue;
      this.matrixData.set(m4identity(mat4()), i * 16);
    }
  }

  /**
   * Recomputes every cascade for the current view.
   *
   * `lambda` blends the uniform and logarithmic split schemes: 0 puts every
   * cascade the same distance apart, 1 packs them near the camera. Around 0.75
   * matches how much detail the eye actually wants close up.
   */
  update(
    cameraPos: Vec3,
    cameraForward: Vec3,
    fovYDegrees: number,
    aspect: number,
    near: number,
    maxDistance: number,
    sunDirection: Vec3,
    frameIndex: number,
    lambda = 0.78,
  ): void {
    const s = this.scratch;

    v3normalize(s.forward, cameraForward);
    // Build a camera basis; guard against looking straight up or down.
    const worldUp = Math.abs(s.forward[1]) > 0.999 ? vec3(0, 0, 1) : vec3(0, 1, 0);
    v3normalize(s.right, v3cross(s.right, s.forward, worldUp));
    v3cross(s.camUp, s.right, s.forward);

    const tanHalfV = Math.tan(fovYDegrees * DEG2RAD * 0.5);
    const tanHalfH = tanHalfV * aspect;

    let previousSplit = near;

    for (let i = 0; i < this.count; i++) {
      const p = (i + 1) / this.count;
      const uniformSplit = near + (maxDistance - near) * p;
      const logSplit = near * Math.pow(maxDistance / near, p);
      const split = uniformSplit + (logSplit - uniformSplit) * lambda;
      const cascade = this.cascades[i];

      // A cascade that is not redrawn must keep the exact matrix its depth was
      // rendered with, or every sample from it lands in the wrong place.
      const interval = CASCADE_INTERVAL[i] ?? 1;
      cascade.dirty = !this.everFitted || frameIndex % interval === 0;

      if (cascade.dirty) {
        this.fitCascade(
          cascade, cameraPos, s.forward,
          tanHalfV, tanHalfH, previousSplit, split, sunDirection,
        );
        this.matrixData.set(cascade.matrix, i * 16);
      }

      cascade.split = split;
      this.splitData[i] = split;

      previousSplit = split;
    }

    // Pad the remaining split slots so the shader's loop terminates cleanly.
    for (let i = this.count; i < 4; i++) this.splitData[i] = maxDistance;

    this.everFitted = true;
  }

  /** False until the first fit, so nothing samples an uninitialised cascade. */
  private everFitted = false;

  private fitCascade(
    cascade: CascadeInfo,
    cameraPos: Vec3, forward: Vec3,
    tanHalfV: number, tanHalfH: number,
    nearDistance: number, farDistance: number,
    sunDirection: Vec3,
  ): void {
    const s = this.scratch;

    // Bounding sphere of the slice. Because the slice is a symmetric frustum,
    // the sphere centre lies on the view axis and both radii can be derived
    // in closed form rather than from the eight corners.
    const a2 = tanHalfH * tanHalfH + tanHalfV * tanHalfV;
    const n = nearDistance;
    const f = farDistance;

    let centreDistance = (f + n) * 0.5 * (1 + a2);
    let radius: number;

    if (centreDistance >= f) {
      // The sphere would sit past the far plane: it is then centred there.
      centreDistance = f;
      radius = f * Math.sqrt(a2);
    } else {
      const dn = centreDistance - n;
      radius = Math.sqrt(dn * dn + a2 * n * n);
      const df = f - centreDistance;
      radius = Math.max(radius, Math.sqrt(df * df + a2 * f * f));
    }

    v3addScaled(s.center, cameraPos, forward, centreDistance);

    // Light basis.
    const lightUp = Math.abs(sunDirection[1]) > 0.999 ? vec3(0, 0, 1) : vec3(0, 1, 0);
    // Pull the light back far enough to include casters above the slice.
    const backDistance = radius + 96;
    v3addScaled(s.lightPos, s.center, sunDirection, backDistance);
    m4lookAt(s.view, s.lightPos, s.center, lightUp);

    // Snap the centre to whole texels *in light space*. Doing it in world space
    // would not stop the shimmer, because the texel grid lives in light space.
    const texelWorldSize = (radius * 2) / this.size;
    m4transformPoint(s.snapped, s.view, s.center);
    s.snapped[0] = Math.floor(s.snapped[0] / texelWorldSize) * texelWorldSize;
    s.snapped[1] = Math.floor(s.snapped[1] / texelWorldSize) * texelWorldSize;

    const left = s.snapped[0] - radius;
    const rightBound = s.snapped[0] + radius;
    const bottom = s.snapped[1] - radius;
    const top = s.snapped[1] + radius;

    // Reversed depth: near and far are swapped so the near plane maps to 1.
    const depthRange = backDistance + radius + 64;
    m4ortho(s.proj, left, rightBound, bottom, top, depthRange, 0.0);

    m4mul(cascade.matrix, s.proj, s.view);
    cascade.frustum.setFromMatrix(cascade.matrix);
    cascade.texelWorldSize = texelWorldSize;

    v3copy(s.center, s.center);
  }

  /** Binds cascade `index` as the current depth attachment. */
  beginCascade(index: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.texture, 0, index);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.viewport(0, 0, this.size, this.size);
    // Reversed depth clears to 0 (infinitely far).
    gl.clearDepth(0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  get framebuffer(): WebGLFramebuffer {
    return this.fbo;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Small helper so the renderer can zero unused vec3 scratch. */
export function zeroVec3(v: Vec3): Vec3 {
  return v3set(v, 0, 0, 0);
}

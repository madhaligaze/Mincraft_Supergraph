/**
 * Compact math layer for the renderer.
 *
 * Everything is column-major Float32Array(16) so matrices can be uploaded to
 * WebGL / packed into uniform buffers without a transpose or a copy.
 */

export type Vec2 = Float32Array;
export type Vec3 = Float32Array;
export type Vec4 = Float32Array;
export type Mat4 = Float32Array;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. `rate` is per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * Math.exp(-rate * dt);

export const fract = (x: number): number => x - Math.floor(x);

/** Euclidean modulo — always returns a value in [0, n). */
export const mod = (x: number, n: number): number => ((x % n) + n) % n;

// ---------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => Float32Array.of(x, y, z);

export function v3set(o: Vec3, x: number, y: number, z: number): Vec3 {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}

export function v3copy(o: Vec3, a: Vec3): Vec3 {
  o[0] = a[0];
  o[1] = a[1];
  o[2] = a[2];
  return o;
}

export function v3add(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o[0] = a[0] + b[0];
  o[1] = a[1] + b[1];
  o[2] = a[2] + b[2];
  return o;
}

export function v3sub(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o[0] = a[0] - b[0];
  o[1] = a[1] - b[1];
  o[2] = a[2] - b[2];
  return o;
}

export function v3scale(o: Vec3, a: Vec3, s: number): Vec3 {
  o[0] = a[0] * s;
  o[1] = a[1] * s;
  o[2] = a[2] * s;
  return o;
}

/** o = a + b * s — the fused form shows up in every integrator here. */
export function v3addScaled(o: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  o[0] = a[0] + b[0] * s;
  o[1] = a[1] + b[1] * s;
  o[2] = a[2] + b[2] * s;
  return o;
}

export function v3mul(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o[0] = a[0] * b[0];
  o[1] = a[1] * b[1];
  o[2] = a[2] * b[2];
  return o;
}

export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function v3cross(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  o[0] = ay * bz - az * by;
  o[1] = az * bx - ax * bz;
  o[2] = ax * by - ay * bx;
  return o;
}

export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export const v3len2 = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];

export function v3normalize(o: Vec3, a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l > 1e-12) {
    const inv = 1 / l;
    o[0] = a[0] * inv;
    o[1] = a[1] * inv;
    o[2] = a[2] * inv;
  } else {
    o[0] = o[1] = o[2] = 0;
  }
  return o;
}

export function v3lerp(o: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}

export const v3dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
// mat4 (column-major)
// ---------------------------------------------------------------------------

export const mat4 = (): Mat4 =>
  Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

export function m4identity(o: Mat4): Mat4 {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function m4copy(o: Mat4, a: Mat4): Mat4 {
  o.set(a);
  return o;
}

export function m4mul(o: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    o[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    o[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    o[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    o[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return o;
}

export function m4translation(o: Mat4, x: number, y: number, z: number): Mat4 {
  m4identity(o);
  o[12] = x;
  o[13] = y;
  o[14] = z;
  return o;
}

export function m4scaling(o: Mat4, x: number, y: number, z: number): Mat4 {
  o.fill(0);
  o[0] = x;
  o[5] = y;
  o[10] = z;
  o[15] = 1;
  return o;
}

/**
 * Reversed-Z infinite perspective.
 *
 * Near plane maps to 1 and infinity maps to 0, which spreads float depth
 * precision across the whole view distance instead of piling it up near the
 * camera. Requires DEPTH_CLEAR = 0 and glDepthFunc(GEQUAL).
 */
export function m4perspectiveReverseZ(o: Mat4, fovY: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovY * 0.5);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = 0;
  o[11] = -1;
  o[14] = near;
  return o;
}

/** Standard finite perspective — used for shadow debug and any [0,1] depth work. */
export function m4perspective(o: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY * 0.5);
  const nf = 1 / (near - far);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) * nf;
  o[11] = -1;
  o[14] = 2 * far * near * nf;
  return o;
}

export function m4ortho(
  o: Mat4,
  left: number, right: number,
  bottom: number, top: number,
  near: number, far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  o.fill(0);
  o[0] = -2 * lr;
  o[5] = -2 * bt;
  o[10] = 2 * nf;
  o[12] = (left + right) * lr;
  o[13] = (top + bottom) * bt;
  o[14] = (far + near) * nf;
  o[15] = 1;
  return o;
}

export function m4lookAt(o: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz);
  if (l < 1e-12) {
    return m4identity(o);
  }
  l = 1 / l;
  zx *= l; zy *= l; zz *= l;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-12) {
    xx = 0; xy = 0; xz = 0;
  } else {
    l = 1 / l;
    xx *= l; xy *= l; xz *= l;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  o[15] = 1;
  return o;
}

export function m4invert(o: Mat4, m: Mat4): Mat4 {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-20) return m4identity(o);
  det = 1 / det;

  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

/** Transform a point (w = 1) and divide through by w. */
export function m4transformPoint(o: Vec3, m: Mat4, p: Vec3): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1;
  o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw;
  o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw;
  o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
  return o;
}

/** Transform a direction (w = 0). */
export function m4transformDir(o: Vec3, m: Mat4, d: Vec3): Vec3 {
  const x = d[0], y = d[1], z = d[2];
  o[0] = m[0] * x + m[4] * y + m[8] * z;
  o[1] = m[1] * x + m[5] * y + m[9] * z;
  o[2] = m[2] * x + m[6] * y + m[10] * z;
  return o;
}

// ---------------------------------------------------------------------------
// Frustum culling
// ---------------------------------------------------------------------------

/**
 * Six view-frustum planes stored as (nx, ny, nz, d) with normals pointing
 * inward, extracted from a view-projection matrix by the Gribb-Hartmann method.
 */
export class Frustum {
  readonly planes = new Float32Array(24);

  /**
   * Works for any projection, including the reversed-Z infinite one: the near
   * and far rows simply swap roles, and both are still valid half-spaces.
   */
  setFromMatrix(m: Mat4): this {
    const p = this.planes;
    // left, right, bottom, top, near, far
    const rows: Array<[number, number]> = [
      [3, 0], [3, 0], [3, 1], [3, 1], [3, 2], [3, 2],
    ];
    const signs = [1, -1, 1, -1, 1, -1];

    for (let i = 0; i < 6; i++) {
      const [wr, cr] = rows[i];
      const s = signs[i];
      const nx = m[0 * 4 + wr] + s * m[0 * 4 + cr];
      const ny = m[1 * 4 + wr] + s * m[1 * 4 + cr];
      const nz = m[2 * 4 + wr] + s * m[2 * 4 + cr];
      const d = m[3 * 4 + wr] + s * m[3 * 4 + cr];
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      p[i * 4] = nx * inv;
      p[i * 4 + 1] = ny * inv;
      p[i * 4 + 2] = nz * inv;
      p[i * 4 + 3] = d * inv;
    }
    return this;
  }

  /** Conservative AABB test: false only when the box is fully outside a plane. */
  intersectsAABB(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const nx = p[i * 4], ny = p[i * 4 + 1], nz = p[i * 4 + 2], d = p[i * 4 + 3];
      // Pick the box corner furthest along the plane normal.
      const px = nx >= 0 ? maxX : minX;
      const py = ny >= 0 ? maxY : minY;
      const pz = nz >= 0 ? maxZ : minZ;
      if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Deterministic hashing / sampling helpers
// ---------------------------------------------------------------------------

/** 32-bit integer hash (Chris Wellons' `lowbias32`). */
export function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0xd35a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

export function hash2i(x: number, y: number): number {
  return hash32(Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1));
}

export function hash3i(x: number, y: number, z: number): number {
  return hash32(
    Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1),
  );
}

/** Seeded, allocation-free PRNG in [0,1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Radical-inverse base 2, for TAA sample jitter. */
export function radicalInverse2(i: number): number {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

/** Halton base 3, the other half of the TAA sequence. */
export function halton3(i: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= 3;
    r += f * (n % 3);
    n = Math.floor(n / 3);
  }
  return r;
}

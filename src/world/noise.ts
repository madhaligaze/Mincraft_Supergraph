/**
 * Simplex noise and the fractal combinators built on it.
 *
 * This is the single hottest CPU path in the project — terrain generation calls
 * into it a few hundred times per chunk column — so everything is monomorphic,
 * allocation-free, and reads from a flat permutation table sized to avoid the
 * modulo in the inner loop.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/** 12 gradient directions on the edges of a cube, the standard simplex set. */
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class Noise {
  /** 512 entries: the doubled 256-permutation, so index wrapping is a mask. */
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    // xorshift32 Fisher-Yates so a given seed always yields the same world.
    let s = seed >>> 0 || 0x9e3779b9;
    for (let i = 255; i > 0; i--) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      const j = s % (i + 1);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** 2D simplex noise in roughly [-1, 1]. */
  noise2(xin: number, yin: number): number {
    const perm = this.perm;
    const permMod12 = this.permMod12;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    // Which of the two triangles of the rhombus are we in?
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2);
    }

    return 70 * n;
  }

  /** 3D simplex noise in roughly [-1, 1]. */
  noise3(xin: number, yin: number, zin: number): number {
    const perm = this.perm;
    const permMod12 = this.permMod12;

    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Rank the coordinates to pick one of the six tetrahedra.
    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0 + GRAD3[gi + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1 + GRAD3[gi + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2 + GRAD3[gi + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[gi] * x3 + GRAD3[gi + 1] * y3 + GRAD3[gi + 2] * z3);
    }

    return 32 * n;
  }

  // -------------------------------------------------------------------------
  // Fractal combinators
  // -------------------------------------------------------------------------

  /** Classic fractal Brownian motion. Result is normalised to about [-1, 1]. */
  fbm2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal in [0, 1].
   *
   * Folding the noise about zero and inverting it turns smooth hills into sharp
   * crests — this is what gives mountains an eroded silhouette rather than the
   * blobby look plain fBm produces.
   */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    let prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise2(x * freq, y * freq));
      n *= n;
      // Weighting each octave by the previous one keeps ridges continuous
      // instead of scattering high-frequency detail into the valleys.
      n *= prev;
      prev = n;
      sum += amp * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Absolute-value ("billow") noise in [0, 1]; good for cloud bases and dunes. */
  billow2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.noise2(x * freq, y * freq));
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/**
 * Worley / cellular noise, returning the distance to the nearest feature point.
 *
 * Used for cave chambers and for the ore-cluster distribution. Kept separate
 * from `Noise` because it needs no permutation table — the feature points come
 * straight from an integer hash.
 */
export class Cellular {
  constructor(private readonly seed: number) {}

  private hash(x: number, y: number, z: number): number {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
    h ^= this.seed;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
    h = Math.imul(h ^ (h >>> 15), 0xd35a2d97);
    return (h ^ (h >>> 15)) >>> 0;
  }

  /** F1 distance, normalised so that ~1.0 is a typical cell radius. */
  f1(x: number, y: number, z: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let best = 1e9;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx, cy = yi + dy, cz = zi + dz;
          const h = this.hash(cx, cy, cz);
          // Three independent 10-bit fields give the jittered feature point.
          const px = cx + ((h & 1023) / 1023);
          const py = cy + (((h >>> 10) & 1023) / 1023);
          const pz = cz + (((h >>> 20) & 1023) / 1023);
          const ddx = px - x, ddy = py - y, ddz = pz - z;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }
}

/**
 * Deterministic value noise on a lattice, sampled with a quintic fade.
 *
 * The procedural texture generator uses this rather than simplex: value noise
 * tiles exactly on integer periods, which is what lets a 128x128 tile repeat
 * across a chunk without a visible seam.
 */
export function tileableValueNoise2(
  x: number, y: number, period: number, seed: number,
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

  const wrap = (n: number): number => ((n % period) + period) % period;

  const h = (ix: number, iy: number): number => {
    let n = Math.imul(wrap(ix), 0x27d4eb2d) ^ Math.imul(wrap(iy), 0x165667b1) ^ seed;
    n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
    n = Math.imul(n ^ (n >>> 15), 0xd35a2d97);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
  };

  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);

  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Tileable fBm built on `tileableValueNoise2`. Returns [0, 1]. */
export function tileableFbm2(
  x: number, y: number, basePeriod: number, octaves: number, seed: number, gain = 0.5,
): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let period = basePeriod;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileableValueNoise2(x * freq, y * freq, period, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= 2;
    period *= 2;
  }
  return sum / norm;
}

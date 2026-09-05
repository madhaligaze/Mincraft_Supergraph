/**
 * Procedural PBR material generation.
 *
 * Every block texture is synthesised at startup into two array textures:
 *
 *   albedo  RGBA8 — base colour and the alpha mask for cutout materials
 *   surface RGBA8 — tangent-space normal XY, roughness, ambient occlusion
 *
 * Nothing is downloaded. A 128px material set is about 6 MB of GPU memory for
 * 46 materials, versus the hundreds of megabytes a comparable resource pack
 * would cost, and it means the detail level is a runtime setting rather than a
 * different download.
 */

import { TEXTURES, type TextureName } from '../world/blocks.ts';

// ---------------------------------------------------------------------------
// Tileable noise primitives
//
// Everything wraps on the tile period, which is what lets a 128px material
// repeat across a 32-block greedy quad without a visible seam.
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0xd35a2d97);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that wraps every `period` cells. */
function value2(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = (n: number): number => ((n % period) + period) % period;

  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const dd = hash2(w(xi + 1), w(yi + 1), seed);
  const ab = a + (b - a) * u;
  const cd = c + (dd - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal sum of `value2`, returning [0, 1]. */
function fbm(x: number, y: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1, sum = 0, norm = 0, freq = 1, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * value2(x * freq, y * freq, p, seed + o * 7919);
    norm += amp;
    amp *= gain;
    freq *= 2;
    p *= 2;
  }
  return sum / norm;
}

/** Ridged variant, for cracks and veins. */
function ridge(x: number, y: number, period: number, octaves: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, freq = 1, p = period;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(value2(x * freq, y * freq, p, seed + o * 3571) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    p *= 2;
  }
  return sum / norm;
}

interface WorleyResult {
  f1: number;
  f2: number;
  /** Deterministic 0..1 id of the nearest cell, for per-cell colour variation. */
  id: number;
}

const worleyScratch: WorleyResult = { f1: 0, f2: 0, id: 0 };

/** Tileable cellular noise; distances are in cell units. */
function worley(x: number, y: number, period: number, seed: number): WorleyResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0;
  const w = (n: number): number => ((n % period) + period) % period;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = w(cx), wy = w(cy);
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed ^ 0x5bf03635);
      const ddx = px - x, ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed ^ 0x1b873593);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  worleyScratch.f1 = f1;
  worleyScratch.f2 = f2;
  worleyScratch.id = id;
  return worleyScratch;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Material description
// ---------------------------------------------------------------------------

/** Per-texel output slots: r, g, b, alpha, height, roughness. */
const CH = 6;

/**
 * `u`/`v` are in [0,1) across the tile; `s` is the tile resolution.
 * Writers must fill all six channels of `out` at `index`.
 */
type MaterialFn = (u: number, v: number, s: number, out: Float32Array, index: number) => void;

function write(
  out: Float32Array, i: number,
  r: number, g: number, b: number, a: number, height: number, rough: number,
): void {
  out[i] = r;
  out[i + 1] = g;
  out[i + 2] = b;
  out[i + 3] = a;
  out[i + 4] = height;
  out[i + 5] = rough;
}

/** Grain shared by all stone-family materials. */
function stoneBase(u: number, v: number, seed: number, tone: number): [number, number, number, number] {
  const grain = fbm(u * 12, v * 12, 12, 4, seed);
  const coarse = fbm(u * 4, v * 4, 4, 3, seed + 51);
  const cracks = 1 - smooth(0.55, 0.9, ridge(u * 7, v * 7, 7, 3, seed + 99));
  const shade = tone * (0.78 + grain * 0.24 + coarse * 0.14) * mix(0.72, 1, cracks);
  return [shade, grain, coarse, cracks];
}

const MATERIALS: Record<TextureName, MaterialFn> = {
  stone: (u, v, _s, out, i) => {
    const [shade, , , cracks] = stoneBase(u, v, 11, 0.52);
    const tint = 0.98 + fbm(u * 3, v * 3, 3, 2, 77) * 0.06;
    write(out, i, shade * tint, shade * tint * 0.995, shade * tint * 1.01, 1,
      shade * 0.8 + cracks * 0.2, 0.86 - cracks * 0.06);
  },

  granite: (u, v, _s, out, i) => {
    const [shade] = stoneBase(u, v, 23, 0.58);
    // Speckles of feldspar; the worley id gives each grain its own value.
    const w = worley(u * 14, v * 14, 14, 31);
    const speck = smooth(0.42, 0.08, w.f1);
    const r = shade * mix(1.06, 1.35, speck * w.id);
    const g = shade * mix(0.86, 1.0, speck * 0.6);
    const b = shade * mix(0.82, 0.94, speck * 0.4);
    write(out, i, r, g, b, 1, shade, 0.78 - speck * 0.12);
  },

  andesite: (u, v, _s, out, i) => {
    const [shade] = stoneBase(u, v, 41, 0.5);
    const w = worley(u * 10, v * 10, 10, 61);
    const patch = smooth(0.5, 0.15, w.f1) * 0.18;
    const c = shade * (1 + patch);
    write(out, i, c, c * 1.005, c * 1.02, 1, shade, 0.88);
  },

  dirt: (u, v, _s, out, i) => {
    // Lower contrast than the first pass: a strong low-frequency clump reads as
    // rust blotches once warm evening light hits it.
    const clump = fbm(u * 11, v * 11, 11, 4, 101);
    const fine = fbm(u * 28, v * 28, 28, 3, 137);
    const grit = worley(u * 16, v * 16, 16, 149).f1;
    const t = 0.76 + clump * 0.26 + fine * 0.18 + smooth(0.4, 0.1, grit) * 0.08;
    write(out, i,
      0.30 * t, 0.222 * t, 0.155 * t, 1,
      clump * 0.5 + fine * 0.35 + (1 - grit) * 0.15, 0.94 - fine * 0.05);
  },

  grass_top: (u, v, _s, out, i) => {
    // Near-luminance, so the biome tint multiplies cleanly. The mean sits
    // below 1 on purpose: at 1.0 the tint arrives undimmed and every biome
    // ends up looking like the same saturated green.
    const blade = fbm(u * 26, v * 26, 26, 3, 211);
    const clump = fbm(u * 6, v * 6, 6, 3, 233);
    const tuft = worley(u * 11, v * 11, 11, 241).f1;
    const l = 0.42 + blade * 0.34 + clump * 0.22 + smooth(0.45, 0.05, tuft) * 0.12;
    write(out, i, l * 0.96, l, l * 0.88, 1,
      blade * 0.5 + clump * 0.3 + (1 - tuft) * 0.2, 0.9 - blade * 0.08);
  },

  grass_side: (u, v, _s, out, i) => {
    const clump = fbm(u * 9, v * 9, 9, 4, 101);
    const fine = fbm(u * 26, v * 26, 26, 3, 137);
    const t = 0.62 + clump * 0.5 + fine * 0.22;
    let r = 0.34 * t, g = 0.235 * t, b = 0.148 * t;

    // Grass fringe hanging over the top edge, with an irregular lower border.
    const fringe = 0.72 + fbm(u * 14, 0, 14, 3, 307) * 0.2;
    if (v > fringe) {
      const blade = fbm(u * 22, v * 22, 22, 3, 211);
      const l = 0.66 + blade * 0.36;
      const k = smooth(fringe, fringe + 0.04, v);
      r = mix(r, l * 0.42, k);
      g = mix(g, l * 0.62, k);
      b = mix(b, l * 0.28, k);
    }
    write(out, i, r, g, b, 1, clump * 0.7 + fine * 0.3, 0.93);
  },

  podzol_top: (u, v, _s, out, i) => {
    const clump = fbm(u * 11, v * 11, 11, 4, 401);
    const t = 0.6 + clump * 0.55;
    write(out, i, 0.30 * t, 0.19 * t, 0.09 * t, 1, clump, 0.95);
  },

  podzol_side: (u, v, _s, out, i) => {
    const clump = fbm(u * 9, v * 9, 9, 4, 101);
    const t = 0.62 + clump * 0.5;
    let r = 0.34 * t, g = 0.235 * t, b = 0.148 * t;
    if (v > 0.78) {
      const k = smooth(0.78, 0.84, v);
      r = mix(r, 0.30 * t, k);
      g = mix(g, 0.19 * t, k);
      b = mix(b, 0.09 * t, k);
    }
    write(out, i, r, g, b, 1, clump, 0.95);
  },

  sand: (u, v, _s, out, i) => {
    const grain = fbm(u * 34, v * 34, 34, 3, 503);
    // Faint wind ripples running on one axis.
    const ripple = Math.sin((u * 9 + fbm(u * 3, v * 3, 3, 2, 511) * 2.5) * Math.PI * 2) * 0.5 + 0.5;
    const t = 0.82 + grain * 0.3 + ripple * 0.08;
    write(out, i, 0.83 * t, 0.75 * t, 0.55 * t, 1, grain * 0.6 + ripple * 0.4, 0.9);
  },

  red_sand: (u, v, _s, out, i) => {
    const grain = fbm(u * 34, v * 34, 34, 3, 613);
    const t = 0.82 + grain * 0.32;
    write(out, i, 0.74 * t, 0.40 * t, 0.21 * t, 1, grain, 0.9);
  },

  gravel: (u, v, _s, out, i) => {
    const w = worley(u * 9, v * 9, 9, 701);
    const pebble = smooth(0.0, 0.42, w.f1);
    const shade = mix(0.62, 0.38, pebble) * (0.85 + w.id * 0.4);
    const grain = fbm(u * 30, v * 30, 30, 2, 719) * 0.12;
    write(out, i, shade + grain, (shade + grain) * 0.98, (shade + grain) * 0.95, 1,
      1 - pebble, 0.92);
  },

  clay: (u, v, _s, out, i) => {
    const n = fbm(u * 8, v * 8, 8, 3, 809);
    const t = 0.82 + n * 0.28;
    write(out, i, 0.62 * t, 0.63 * t, 0.68 * t, 1, n, 0.72);
  },

  sandstone_top: (u, v, _s, out, i) => {
    const grain = fbm(u * 20, v * 20, 20, 3, 907);
    const t = 0.86 + grain * 0.24;
    write(out, i, 0.85 * t, 0.79 * t, 0.60 * t, 1, grain, 0.88);
  },

  sandstone_side: (u, v, _s, out, i) => {
    // Horizontal sedimentary banding.
    const band = fbm(u * 2, v * 16, 16, 3, 911);
    const layer = Math.abs(((v * 6) % 1) - 0.5) * 2;
    const t = 0.8 + band * 0.24 + layer * 0.1;
    write(out, i, 0.84 * t, 0.77 * t, 0.58 * t, 1, band * 0.5 + layer * 0.5, 0.88);
  },

  snow: (u, v, _s, out, i) => {
    // Snow is smooth at close range and its shape comes from low-frequency
    // drifts. Driving the normal from a high-frequency field, as the other
    // granular materials do, turns a snowfield into blue static.
    const drift = fbm(u * 3, v * 3, 3, 3, 1009);
    const grain = fbm(u * 24, v * 24, 24, 2, 1021);
    const sparkle = worley(u * 34, v * 34, 34, 1013).f1;
    const glint = smooth(0.13, 0.0, sparkle) * 0.1;
    const t = 0.88 + drift * 0.1 + grain * 0.045;
    write(out, i,
      0.80 * t + glint, 0.83 * t + glint, 0.90 * t + glint,
      1, drift, 0.62 - glint * 0.9);
  },

  ice: (u, v, _s, out, i) => {
    const crack = ridge(u * 6, v * 6, 6, 3, 1103);
    const n = fbm(u * 10, v * 10, 10, 3, 1117);
    const t = 0.86 + n * 0.16;
    write(out, i, 0.62 * t, 0.79 * t, 0.94 * t, 0.72, crack, 0.06 + crack * 0.2);
  },

  packed_ice: (u, v, _s, out, i) => {
    const n = fbm(u * 12, v * 12, 12, 3, 1201);
    const t = 0.88 + n * 0.16;
    write(out, i, 0.66 * t, 0.82 * t, 0.95 * t, 1, n, 0.16);
  },

  bedrock: (u, v, _s, out, i) => {
    const w = worley(u * 7, v * 7, 7, 1301);
    const n = fbm(u * 18, v * 18, 18, 3, 1303);
    const shade = mix(0.14, 0.42, w.id) * (0.7 + n * 0.6);
    write(out, i, shade, shade, shade * 1.03, 1, n, 0.95);
  },

  cobblestone: (u, v, _s, out, i) => {
    const w = worley(u * 6, v * 6, 6, 1409);
    // f2 - f1 is small near a cell border, which is exactly the mortar line.
    const mortar = smooth(0.0, 0.14, w.f2 - w.f1);
    const stone = mix(0.30, 0.62, w.id) * (0.85 + fbm(u * 20, v * 20, 20, 3, 1423) * 0.32);
    const shade = mix(0.24, stone, mortar);
    write(out, i, shade, shade * 0.99, shade * 0.98, 1, mortar, mix(0.96, 0.85, mortar));
  },

  mossy_cobblestone: (u, v, _s, out, i) => {
    const w = worley(u * 6, v * 6, 6, 1409);
    const mortar = smooth(0.0, 0.14, w.f2 - w.f1);
    const stone = mix(0.30, 0.62, w.id) * (0.85 + fbm(u * 20, v * 20, 20, 3, 1423) * 0.32);
    let r = mix(0.24, stone, mortar);
    let g = r * 0.99, b = r * 0.98;
    const moss = smooth(0.48, 0.78, fbm(u * 6, v * 6, 6, 3, 1499));
    // Moss darkens and desaturates the stone rather than painting it green;
    // a saturated overlay reads as slime.
    r = mix(r, r * 0.62, moss);
    g = mix(g, g * 0.86 + 0.035, moss);
    b = mix(b, b * 0.46, moss);
    write(out, i, r, g, b, 1, mortar, mix(0.96, 0.9, moss));
  },

  oak_log_top: (u, v, _s, out, i) => {
    // Growth rings, warped by low-frequency noise so they are eccentric rather
    // than perfect circles, and kept low in contrast — a hard bullseye is the
    // single most obvious "procedural texture" tell.
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * (0.85 + fbm(u * 3, v * 3, 3, 2, 1601) * 0.35);
    const rings = Math.sin(r * 46) * 0.5 + 0.5;
    const grain = fbm(u * 26, v * 26, 26, 2, 1607);
    const t = 0.74 + rings * 0.17 + grain * 0.14;
    write(out, i, 0.55 * t, 0.40 * t, 0.22 * t, 1, rings * 0.6 + grain * 0.4, 0.82);
  },

  oak_log_side: (u, v, _s, out, i) => {
    // Bark: strong vertical streaks with occasional deep fissures.
    const streak = fbm(u * 26, v * 4, 26, 4, 1609);
    const fissure = ridge(u * 12, v * 3, 12, 3, 1613);
    const t = 0.5 + streak * 0.46 - smooth(0.6, 1.0, fissure) * 0.25;
    write(out, i, 0.40 * t, 0.28 * t, 0.16 * t, 1, streak * 0.6 + fissure * 0.4, 0.9);
  },

  birch_log_top: (u, v, _s, out, i) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * (0.9 + fbm(u * 3, v * 3, 3, 2, 1709) * 0.24);
    const rings = Math.sin(r * 50) * 0.5 + 0.5;
    const grain = fbm(u * 24, v * 24, 24, 2, 1713);
    const t = 0.82 + rings * 0.11 + grain * 0.1;
    write(out, i, 0.82 * t, 0.74 * t, 0.58 * t, 1, rings * 0.5 + grain * 0.5, 0.8);
  },

  birch_log_side: (u, v, _s, out, i) => {
    const base = 0.86 + fbm(u * 18, v * 6, 18, 3, 1721) * 0.18;
    // Dark horizontal lenticels.
    const mark = smooth(0.62, 0.78, fbm(u * 5, v * 14, 14, 3, 1733));
    const t = mix(base, 0.16, mark);
    write(out, i, 0.92 * t, 0.90 * t, 0.84 * t, 1, mark, 0.86);
  },

  spruce_log_top: (u, v, _s, out, i) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * (0.88 + fbm(u * 3, v * 3, 3, 2, 1787) * 0.3);
    const rings = Math.sin(r * 54) * 0.5 + 0.5;
    const grain = fbm(u * 28, v * 28, 28, 2, 1789);
    const t = 0.7 + rings * 0.16 + grain * 0.15;
    write(out, i, 0.42 * t, 0.29 * t, 0.18 * t, 1, rings * 0.6 + grain * 0.4, 0.84);
  },

  spruce_log_side: (u, v, _s, out, i) => {
    const streak = fbm(u * 30, v * 5, 30, 4, 1801);
    const t = 0.42 + streak * 0.42;
    write(out, i, 0.31 * t, 0.21 * t, 0.13 * t, 1, streak, 0.92);
  },

  oak_planks: (u, v, _s, out, i) => {
    // Four boards with alternating offsets and a dark gap between them.
    const boards = 4;
    const row = Math.floor(v * boards);
    const offset = hash2(row, 0, 1901);
    const gap = smooth(0.0, 0.035, Math.abs((v * boards) % 1 - 0.5) * 2 - 0.93);
    const grain = fbm((u + offset) * 30, v * 6, 30, 3, 1907 + row * 13);
    const t = (0.66 + grain * 0.36 + offset * 0.1) * mix(1, 0.45, gap);
    write(out, i, 0.63 * t, 0.46 * t, 0.27 * t, 1, grain * (1 - gap), mix(0.72, 0.9, gap));
  },

  oak_leaves: (u, v, _s, out, i) => leafMaterial(u, v, out, i, 2003, 0.34),
  birch_leaves: (u, v, _s, out, i) => leafMaterial(u, v, out, i, 2011, 0.30),
  spruce_leaves: (u, v, _s, out, i) => leafMaterial(u, v, out, i, 2017, 0.42),

  coal_ore: (u, v, _s, out, i) => oreMaterial(u, v, out, i, 2111, 0.06, 0.06, 0.07, 0.55),
  iron_ore: (u, v, _s, out, i) => oreMaterial(u, v, out, i, 2113, 0.72, 0.55, 0.42, 0.35),
  gold_ore: (u, v, _s, out, i) => oreMaterial(u, v, out, i, 2129, 0.95, 0.74, 0.24, 0.2),
  diamond_ore: (u, v, _s, out, i) => oreMaterial(u, v, out, i, 2131, 0.42, 0.88, 0.92, 0.12),

  glowstone: (u, v, _s, out, i) => {
    const w = worley(u * 8, v * 8, 8, 2203);
    const cell = smooth(0.36, 0.05, w.f1);
    const t = 0.55 + cell * 0.65 + w.id * 0.2;
    write(out, i, 1.0 * t, 0.82 * t, 0.42 * t, 1, cell, 0.6 - cell * 0.25);
  },

  glass: (u, v, _s, out, i) => {
    // A thin frame plus a faint smudge so the pane catches specular.
    const edge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
    const frame = smooth(0.055, 0.03, edge);
    const smudge = fbm(u * 8, v * 8, 8, 3, 2309) * 0.06;
    const alpha = mix(0.10 + smudge, 0.82, frame);
    write(out, i, 0.86, 0.92, 0.96, alpha, frame, 0.03);
  },

  water: (u, v, _s, out, i) => {
    // Detail comes from the wave shader; the texture only breaks up flatness.
    const n = fbm(u * 6, v * 6, 6, 3, 2411);
    write(out, i, 0.16, 0.36, 0.42, 0.78, n, 0.02);
  },

  lava: (u, v, _s, out, i) => {
    const flow = fbm(u * 5, v * 5, 5, 4, 2503);
    const crust = smooth(0.42, 0.62, flow);
    const r = mix(1.0, 0.28, crust);
    const g = mix(0.48, 0.10, crust);
    const b = mix(0.07, 0.05, crust);
    write(out, i, r, g, b, 1, flow, 0.55 + crust * 0.3);
  },

  tall_grass: (u, v, _s, out, i) => bladeMaterial(u, v, out, i, 2609, 6, 1.0),
  fern: (u, v, _s, out, i) => fernMaterial(u, v, out, i, 2617),

  flower_red: (u, v, _s, out, i) => flowerMaterial(u, v, out, i, 2707, 0.85, 0.13, 0.13),
  flower_yellow: (u, v, _s, out, i) => flowerMaterial(u, v, out, i, 2711, 0.95, 0.82, 0.18),
  flower_blue: (u, v, _s, out, i) => flowerMaterial(u, v, out, i, 2713, 0.35, 0.45, 0.88),

  dead_bush: (u, v, _s, out, i) => {
    // Several twigs fanning out from a common root, each a slightly different
    // curve. One or two lines read as a stick; five read as a bush.
    let a = 0;
    for (let t = 0; t < 5; t++) {
      const lean = (hash2(t, 0, 3011) - 0.5) * 1.5;
      const bend = (hash2(t, 1, 3011) - 0.5) * 0.9;
      const top = 0.45 + hash2(t, 2, 3011) * 0.5;
      if (v > top) continue;
      const p = v / top;
      const centre = 0.5 + lean * p * 0.42 + bend * p * p * 0.2;
      const width = 0.028 * (1 - p * 0.7);
      a = Math.max(a, smooth(width + 0.006, width - 0.006, Math.abs(u - centre)));
    }
    const shade = 0.8 + fbm(u * 12, v * 12, 12, 2, 3019) * 0.4;
    write(out, i, 0.40 * shade, 0.30 * shade, 0.16 * shade, a > 0.45 ? 1 : 0, a, 0.95);
  },

  cactus_top: (u, v, _s, out, i) => {
    const r = Math.hypot(u - 0.5, v - 0.5);
    const n = fbm(u * 14, v * 14, 14, 3, 2803);
    const t = (0.6 + n * 0.4) * mix(1, 0.7, smooth(0.34, 0.46, r));
    write(out, i, 0.24 * t, 0.44 * t, 0.18 * t, 1, n, 0.82);
  },

  cactus_side: (u, v, _s, out, i) => {
    // Vertical ribs with spines sitting in the grooves.
    const rib = Math.abs(((u * 4) % 1) - 0.5) * 2;
    const spine = smooth(0.9, 1.0, rib) * smooth(0.6, 0.75, fbm(u * 4, v * 22, 22, 2, 2819));
    const t = 0.6 + rib * 0.32;
    write(out, i,
      mix(0.22 * t, 0.85, spine),
      mix(0.46 * t, 0.83, spine),
      mix(0.17 * t, 0.7, spine),
      1, rib * 0.7 + spine * 0.3, 0.85);
  },
};

function leafMaterial(
  u: number, v: number, out: Float32Array, i: number, seed: number, holeAmount: number,
): void {
  // Individual leaves come from a cellular pattern; each cell is one leaf, and
  // the per-cell id gives it its own shade. A pure fbm here reads as moss.
  const cells = worley(u * 7, v * 7, 7, seed);
  const leafShape = smooth(0.62, 0.10, cells.f1);
  const detail = fbm(u * 30, v * 30, 30, 2, seed + 31);
  const clump = fbm(u * 5, v * 5, 5, 3, seed + 11);

  // Coverage: mostly solid with scattered gaps between leaf cells, the edges
  // roughened by a second frequency so the silhouette is ragged. `holeAmount`
  // maps to how much of the tile is cut away.
  const cover = leafShape * 0.7 + fbm(u * 11, v * 11, 11, 3, seed + 77) * 0.58;
  const alpha = cover > 0.30 + holeAmount * 0.42 ? 1 : 0;

  // Lower per-cell contrast than the first pass: a wide spread of per-leaf
  // values turns the canopy into speckled noise once mipmapping kicks in.
  const l = (0.40 + cells.id * 0.2 + clump * 0.22 + detail * 0.13) * mix(0.78, 1.04, leafShape);
  write(out, i,
    l * 0.82, l, l * 0.66, alpha,
    leafShape * 0.6 + detail * 0.25 + clump * 0.15,
    0.86 - detail * 0.08);
}

function oreMaterial(
  u: number, v: number, out: Float32Array, i: number,
  seed: number, r: number, g: number, b: number, rough: number,
): void {
  const [shade] = stoneBase(u, v, 11, 0.52);
  const w = worley(u * 4, v * 4, 4, seed);
  const blob = smooth(0.34, 0.14, w.f1) * (w.id > 0.42 ? 1 : 0);
  const sparkle = smooth(0.2, 0.05, worley(u * 16, v * 16, 16, seed + 5).f1) * blob;
  write(out, i,
    mix(shade, r, blob) + sparkle * 0.3,
    mix(shade * 0.99, g, blob) + sparkle * 0.3,
    mix(shade * 1.01, b, blob) + sparkle * 0.3,
    1, mix(shade, 0.9, blob), mix(0.86, rough, blob));
}

/** Cross-quad plant: a fan of blades rising from the bottom edge. */
function bladeMaterial(
  u: number, v: number, out: Float32Array, i: number,
  seed: number, blades: number, heightScale: number,
): void {
  let alpha = 0;
  let shade = 0;

  for (let b = 0; b < blades; b++) {
    const root = (b + 0.5) / blades + (hash2(b, 0, seed) - 0.5) * 0.16;
    const lean = (hash2(b, 1, seed) - 0.5) * 0.5;
    const top = (0.55 + hash2(b, 2, seed) * 0.45) * heightScale;
    if (v > top) continue;

    const t = v / top;
    // Blades taper and curve; the curve is what stops them looking like bars.
    const centre = root + lean * t * t;
    const width = 0.032 * (1 - t * 0.85);
    const d = Math.abs(u - centre);
    if (d < width) {
      alpha = 1;
      shade = Math.max(shade, 0.45 + t * 0.55 + hash2(b, 3, seed) * 0.2);
    }
  }

  const l = shade;
  write(out, i, l * 0.8, l, l * 0.6, alpha, l, 0.9);
}

/**
 * Fern: three fronds, each a central rachis with paired leaflets stepping
 * outward. The paired structure is what distinguishes it from tall grass at a
 * glance, which is the whole reason both exist.
 */
function fernMaterial(u: number, v: number, out: Float32Array, i: number, seed: number): void {
  let alpha = 0;
  let shade = 0;

  for (let f = 0; f < 3; f++) {
    const root = (f + 0.5) / 3 + (hash2(f, 0, seed) - 0.5) * 0.2;
    const lean = (hash2(f, 1, seed) - 0.5) * 0.7;
    const top = 0.5 + hash2(f, 2, seed) * 0.42;
    if (v > top) continue;

    const t = v / top;
    const rachis = root + lean * t * t;

    // Central stem.
    if (Math.abs(u - rachis) < 0.012) {
      alpha = 1;
      shade = Math.max(shade, 0.4 + t * 0.4);
    }

    // Leaflets: length tapers toward the tip, and they alternate sides.
    const span = 0.085 * (1 - t * 0.8);
    const rung = Math.abs(((v * 26) % 1) - 0.5) * 2;
    const distance = Math.abs(u - rachis);
    if (distance < span && rung > 0.45) {
      alpha = 1;
      shade = Math.max(shade, 0.5 + t * 0.5 - distance * 1.4);
    }
  }

  const l = shade;
  write(out, i, l * 0.72, l * 0.98, l * 0.58, alpha, l, 0.9);
}

function flowerMaterial(
  u: number, v: number, out: Float32Array, i: number,
  seed: number, r: number, g: number, b: number,
): void {
  // Stem: slightly curved, thin, stopping just under the head.
  const stemX = 0.5 + Math.sin(v * 2.6 + seed) * 0.05;
  const stem = smooth(0.028, 0.010, Math.abs(u - stemX)) *
    smooth(0.0, 0.05, v) * smooth(0.72, 0.60, v);

  // Five petals around a centre in the upper third.
  const cx = stemX + Math.sin(2.6 + seed) * 0.05;
  const cy = 0.70;
  const dx = u - cx, dy = (v - cy) * 1.12;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const petal = 0.235 * (0.68 + 0.32 * Math.cos(angle * 5 + seed));
  const head = smooth(petal + 0.015, petal - 0.015, dist);
  const core = smooth(0.075, 0.03, dist);

  // A pair of leaves low on the stem, mirrored about it.
  const leafT = smooth(0.14, 0.24, v) * smooth(0.44, 0.32, v);
  const leafOffset = Math.abs(u - stemX) - (v - 0.14) * 0.55;
  const leaf = smooth(0.05, 0.015, Math.abs(leafOffset)) * leafT;

  const alpha = head > 0.5 || stem > 0.5 || leaf > 0.5 ? 1 : 0;

  let cr: number, cg: number, cb: number;
  if (head > 0.5) {
    cr = mix(r, 1.0, core);
    cg = mix(g, 0.92, core);
    cb = mix(b, 0.38, core);
  } else {
    const shade = 0.85 + (leaf > 0.5 ? 0.25 : 0);
    cr = 0.22 * shade; cg = 0.42 * shade; cb = 0.17 * shade;
  }
  write(out, i, cr, cg, cb, alpha, head * 0.6 + stem * 0.25 + leaf * 0.15, 0.82);
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

export interface MaterialTextures {
  albedo: WebGLTexture;
  /** RG = tangent normal, B = roughness, A = ambient occlusion. */
  surface: WebGLTexture;
  layerCount: number;
  size: number;
}

/**
 * Bakes one material to CPU arrays. Used by the material contact-sheet page,
 * and by `generateMaterials` itself, so what the sheet shows is exactly what
 * the GPU receives.
 */
export function bakeMaterial(
  name: TextureName, size: number,
): { albedo: Uint8Array; surface: Uint8Array } {
  const scratch = new Float32Array(size * size * CH);
  const albedo = new Uint8Array(size * size * 4);
  const surface = new Uint8Array(size * size * 4);
  const fn = MATERIALS[name];

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      fn(u, v, size, scratch, (y * size + x) * CH);
    }
  }

  for (let p = 0; p < size * size; p++) {
    const i = p * CH;
    albedo[p * 4] = Math.round(clamp01(scratch[i]) * 255);
    albedo[p * 4 + 1] = Math.round(clamp01(scratch[i + 1]) * 255);
    albedo[p * 4 + 2] = Math.round(clamp01(scratch[i + 2]) * 255);
    albedo[p * 4 + 3] = Math.round(clamp01(scratch[i + 3]) * 255);
  }

  packSurface(scratch, size, surface, (NORMAL_STRENGTH[name] ?? 1.8) * (size / 128));
  return { albedo, surface };
}

/**
 * Derives a tangent-space normal from the height field with a Sobel filter and
 * packs an inexpensive cavity-style AO from the same field.
 */
function packSurface(
  scratch: Float32Array, size: number, layer: Uint8Array, strength: number,
): void {
  const at = (x: number, y: number): number => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return scratch[(yi * size + xi) * CH + 4];
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;

      const i = (y * size + x) * CH;
      // Cavity AO: a texel lower than its neighbourhood is occluded.
      const local = (tl + t + tr + l + r + bl + b + br) / 8;
      const ao = clamp01(0.55 + (scratch[i + 4] - local) * 2.2 + 0.45);

      const o = (y * size + x) * 4;
      layer[o] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      layer[o + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
      layer[o + 2] = Math.round(clamp01(scratch[i + 5]) * 255);
      layer[o + 3] = Math.round(ao * 255);
    }
  }
}

/** Per-material normal strength; flat materials get a gentler slope. */
const NORMAL_STRENGTH: Partial<Record<TextureName, number>> = {
  water: 0.2, glass: 0.6, ice: 0.45, packed_ice: 0.4, snow: 0.5,
  grass_top: 1.0, clay: 0.9, oak_leaves: 1.1, birch_leaves: 1.1, spruce_leaves: 1.1,
  cobblestone: 3.2, mossy_cobblestone: 3.2, gravel: 3.0, bedrock: 2.6,
  oak_log_side: 2.6, spruce_log_side: 2.6, oak_planks: 2.2, cactus_side: 2.4,
  tall_grass: 0.4, fern: 0.4, flower_red: 0.4, flower_yellow: 0.4,
  flower_blue: 0.4, dead_bush: 0.4,
};

/**
 * Generates both array textures. `onProgress` is called between materials so a
 * caller can drive a loading bar; the whole set takes roughly 200 ms at 128px
 * on the target hardware.
 */
export function generateMaterials(
  gl: WebGL2RenderingContext,
  size: number,
  anisotropy: number,
  onProgress?: (done: number, total: number, name: string) => void,
): MaterialTextures {
  const layers = TEXTURES.length;

  const albedo = createArrayTexture(gl, size, layers, anisotropy, true);
  const surface = createArrayTexture(gl, size, layers, anisotropy, false);

  for (let layer = 0; layer < layers; layer++) {
    const name = TEXTURES[layer];
    const { albedo: albedoLayer, surface: surfaceLayer } = bakeMaterial(name, size);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, albedo);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, albedoLayer,
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, surface);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, surfaceLayer,
    );

    onProgress?.(layer + 1, layers, name);
  }

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, albedo);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, surface);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

  return { albedo, surface, layerCount: layers, size };
}

function createArrayTexture(
  gl: WebGL2RenderingContext,
  size: number,
  layers: number,
  anisotropy: number,
  srgb: boolean,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Не удалось создать массив текстур');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);

  const levels = Math.floor(Math.log2(size)) + 1;
  // Albedo is authored in sRGB so the GPU linearises it for free on sample;
  // the surface map holds raw vectors and must stay linear.
  gl.texStorage3D(
    gl.TEXTURE_2D_ARRAY, levels,
    srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8,
    size, size, layers,
  );

  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);

  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext && anisotropy > 1) {
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, anisotropy);
  }

  return tex;
}

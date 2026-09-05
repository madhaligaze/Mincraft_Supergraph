// Tone mapping and colour space helpers.

#ifndef LIB_TONEMAP
#define LIB_TONEMAP

#include "lib/common.glsl"

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(1e-5)), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

// ACES, via Stephen Hill's fit of the RRT+ODT. Compared with the cheaper
// Narkowicz approximation this keeps saturation in bright skies instead of
// bleaching the sun's surroundings to white, which is exactly where a voxel
// sunset lives or dies.
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);

const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 tonemapACES(vec3 color) {
  color = ACES_INPUT * color;
  color = rrtOdtFit(color);
  color = ACES_OUTPUT * color;
  return saturate(color);
}

/** AgX-style contrast curve applied in log space, for a filmic toe. */
vec3 filmicContrast(vec3 color, float contrast, float pivot) {
  vec3 logColor = log2(max(color, vec3(1e-5)));
  logColor = (logColor - pivot) * contrast + pivot;
  return exp2(logColor);
}

/** Rotates saturation without shifting hue. */
vec3 adjustSaturation(vec3 color, float amount) {
  return mix(vec3(luminance(color)), color, amount);
}

/**
 * Reinhard weighting used before a bilinear resolve. Averaging HDR samples
 * directly lets one fireflies pixel dominate; weighting by 1/(1+luma) first
 * makes the average behave.
 */
vec3 tonemapForResolve(vec3 c) { return c / (1.0 + luminance(c)); }
vec3 untonemapForResolve(vec3 c) { return c / max(1.0 - luminance(c), 1e-4); }

#endif

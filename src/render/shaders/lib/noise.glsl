// Runtime noise for clouds, water and weather.
//
// All of it is analytic rather than texture-fetched. On a bandwidth-starved
// iGPU an ALU-heavy noise beats a 3D texture lookup, and it removes another
// asset from the build.

#ifndef LIB_NOISE
#define LIB_NOISE

#include "lib/common.glsl"

float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  // Quintic fade: C2 continuous, so fbm derivatives stay smooth.
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n000 = hash12(i.xy + i.z * 113.0);
  float n100 = hash12(i.xy + vec2(1.0, 0.0) + i.z * 113.0);
  float n010 = hash12(i.xy + vec2(0.0, 1.0) + i.z * 113.0);
  float n110 = hash12(i.xy + vec2(1.0, 1.0) + i.z * 113.0);
  float n001 = hash12(i.xy + (i.z + 1.0) * 113.0);
  float n101 = hash12(i.xy + vec2(1.0, 0.0) + (i.z + 1.0) * 113.0);
  float n011 = hash12(i.xy + vec2(0.0, 1.0) + (i.z + 1.0) * 113.0);
  float n111 = hash12(i.xy + vec2(1.0, 1.0) + (i.z + 1.0) * 113.0);

  float x00 = mix(n000, n100, f.x);
  float x10 = mix(n010, n110, f.x);
  float x01 = mix(n001, n101, f.x);
  float x11 = mix(n011, n111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise3(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.02;
  }
  return sum / norm;
}

/**
 * Inverted Worley, the standard building block for cloud billows.
 * Returns 1 at a cell centre and falls off toward the borders.
 */
float worley3(vec3 p, float scale) {
  p *= scale;
  vec3 i = floor(p);
  vec3 f = fract(p);
  float best = 1.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 offset = vec3(float(x), float(y), float(z));
        vec3 point = offset + hash33(i + offset) - f;
        best = min(best, dot(point, point));
      }
    }
  }
  return 1.0 - sqrt(best);
}

/** Layered Worley, the classic "billowy cloud detail" stack. */
float worleyFbm(vec3 p, float scale) {
  return worley3(p, scale) * 0.625 +
         worley3(p, scale * 2.0) * 0.25 +
         worley3(p, scale * 4.0) * 0.125;
}

float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  // Rotating each octave decorrelates them, which removes the axis-aligned
  // grid pattern plain value-noise fbm otherwise shows on flat water.
  const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise2(p);
    norm += amp;
    amp *= 0.5;
    p = rot * p * 2.03;
  }
  return sum / norm;
}

/**
 * Sum of Gerstner waves for the water surface.
 * Returns height in `.x` and the surface gradient in `.yz`, so the normal comes
 * out of the same evaluation instead of needing finite differences.
 */
vec3 gerstnerWaves(vec2 pos, float time, float windAngle, float amplitude, int count) {
  float height = 0.0;
  vec2 gradient = vec2(0.0);

  float frequency = 0.28;
  float amp = amplitude;
  float speed = 1.15;
  float angle = windAngle;

  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec2 dir = vec2(cos(angle), sin(angle));
    float phase = dot(dir, pos) * frequency + time * speed;
    float s = sin(phase);
    float c = cos(phase);

    height += amp * s;
    gradient += dir * (amp * frequency * c);

    // Each successive wave is shorter, faster, weaker and turned a little,
    // which is what makes the surface read as wind-driven chop.
    frequency *= 1.83;
    amp *= 0.62;
    speed *= 1.24;
    angle += 1.17;
  }

  return vec3(height, gradient);
}

#endif

// Shared constants, packing helpers and small utilities.

#ifndef LIB_COMMON
#define LIB_COMMON

const float PI = 3.14159265359;
const float TAU = 6.28318530718;
const float INV_PI = 0.31830988618;

#define saturate(x) clamp(x, 0.0, 1.0)

float sq(float x) { return x * x; }
vec2 sq(vec2 x) { return x * x; }
vec3 sq(vec3 x) { return x * x; }

float maxComponent(vec3 v) { return max(v.x, max(v.y, v.z)); }

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * Octahedral normal encoding: a unit vector into two [0,1] values.
 * Used for the depth-prepass normal buffer, where an RGBA8 target has to hold
 * a normal plus roughness plus a material id.
 */
vec2 encodeNormalOct(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.xy;
  if (n.z < 0.0) {
    e = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  }
  return e * 0.5 + 0.5;
}

vec3 decodeNormalOct(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = saturate(-n.z);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}

/** Builds a tangent frame around `n` without needing per-vertex tangents. */
mat3 tangentFrame(vec3 n, vec3 tangentHint) {
  vec3 t = normalize(tangentHint - n * dot(n, tangentHint));
  vec3 b = cross(n, t);
  return mat3(t, b, n);
}

/** Interleaved gradient noise — the cheapest good per-pixel dither. */
float interleavedGradientNoise(vec2 uv) {
  return fract(52.9829189 * fract(dot(uv, vec2(0.06711056, 0.00583715))));
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/** Ray-sphere intersection returning the nearest positive t, or -1. */
float raySphere(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  if (c > 0.0 && b > 0.0) return -1.0;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float sqrtDisc = sqrt(disc);
  if (disc > b * b) return -b + sqrtDisc;
  return -b - sqrtDisc;
}

/** Maps a [0,1] texture coordinate to the centre of the addressed texel. */
float fromUnitToSubUv(float u, float resolution) {
  return (u + 0.5 / resolution) * (resolution / (resolution + 1.0));
}

float fromSubUvToUnit(float u, float resolution) {
  return (u - 0.5 / resolution) * (resolution / (resolution - 1.0));
}

#endif

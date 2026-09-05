// Shared vertex decoding for every chunk pass (main, depth prepass, shadow).
//
// The mesher packs a vertex into 12 bytes; everything below unpacks it. Keeping
// this in one header means the depth prepass and the shading pass compute
// identical positions, which is what lets the main pass run with GEQUAL depth
// testing and depth writes disabled.

#ifndef CHUNK_COMMON
#define CHUNK_COMMON

#include "lib/common.glsl"
#include "lib/scene.glsl"

layout(location = 0) in uvec3 aPos;
layout(location = 1) in uvec2 aUV;
layout(location = 2) in uint aData;

/** World-space origin of this chunk section. */
uniform vec3 uChunkOrigin;

/** Biome tint atlas: layer 0 grass, layer 1 foliage, layer 2 surface info. */
uniform sampler2DArray uTintAtlas;
/** x = 1 / atlas size in blocks. */
uniform vec2 uTintParams;

/**
 * Positions are stored in eighths of a block, offset by one block so that
 * geometry extending slightly outside its section (cross-shaped plants) stays
 * positive in the unsigned attribute.
 */
const float POSITION_SCALE = 1.0 / 8.0;
const float POSITION_BIAS = 1.0;

const vec3 FACE_NORMAL[6] = vec3[6](
  vec3( 1.0,  0.0,  0.0),
  vec3(-1.0,  0.0,  0.0),
  vec3( 0.0,  1.0,  0.0),
  vec3( 0.0, -1.0,  0.0),
  vec3( 0.0,  0.0,  1.0),
  vec3( 0.0,  0.0, -1.0)
);

/**
 * World direction the texture's U axis runs along, per face.
 *
 * This is the mesher's tile layout, not its greedy sweep basis: on +X and -Z
 * the mesher transposes the tile coordinates (`FACE_SWAP_UV`) so that the
 * world vertical always lands on V. Anything that works in texture space —
 * normal maps, parallax — has to follow that transposition, or bumps come out
 * mirrored across the diagonal on those two faces.
 */
const vec3 FACE_TEX_U[6] = vec3[6](
  vec3( 0.0,  0.0,  1.0),
  vec3( 0.0,  0.0,  1.0),
  vec3( 0.0,  0.0,  1.0),
  vec3( 1.0,  0.0,  0.0),
  vec3( 1.0,  0.0,  0.0),
  vec3( 1.0,  0.0,  0.0)
);

/**
 * Handedness of that UV frame: the transposition mirrors it, so on +X and -Z
 * the V axis is `-cross(normal, U)` rather than `+cross(normal, U)`. Feeding
 * the mirrored sign into the bitangent is the standard way to shade a mirrored
 * UV mapping without a second table.
 */
const float FACE_UV_SIGN[6] = float[6](-1.0, 1.0, 1.0, 1.0, 1.0, -1.0);

struct ChunkVertex {
  vec3 localPos;
  vec2 uv;
  uint texLayer;
  uint face;
  float ao;
  float skyLight;
  float blockLight;
  uint tintMode;
  bool wind;
};

ChunkVertex decodeChunkVertex() {
  ChunkVertex v;
  v.localPos = vec3(aPos) * POSITION_SCALE - POSITION_BIAS;
  v.uv = vec2(aUV);
  v.texLayer = aData & 0x1ffu;
  v.face = (aData >> 9) & 7u;
  v.ao = float((aData >> 12) & 3u) * (1.0 / 3.0);
  v.skyLight = float((aData >> 14) & 15u) * (1.0 / 15.0);
  v.blockLight = float((aData >> 18) & 15u) * (1.0 / 15.0);
  v.tintMode = (aData >> 22) & 3u;
  v.wind = ((aData >> 24) & 1u) != 0u;
  return v;
}

/**
 * Toroidal lookup into the tint atlas; wrapping is handled by GL_REPEAT.
 *
 * Biome colours are authored the way a person reads a colour — as sRGB — but
 * shading needs linear reflectance. The atlas cannot be an sRGB texture because
 * its fourth layer carries terrain data that must not be gamma-decoded, so the
 * conversion happens here instead.
 */
vec3 sampleTintAtlas(vec2 worldXZ, float layer) {
  vec3 encoded = texture(uTintAtlas, vec3(worldXZ * uTintParams.x, layer)).rgb;
  return encoded * (encoded * (encoded * 0.305306011 + 0.682171111) + 0.012522878);
}

vec3 vertexTint(uint tintMode, vec2 worldXZ) {
  if (tintMode == 0u) return vec3(1.0);
  return sampleTintAtlas(worldXZ, tintMode == 1u ? 0.0 : 1.0);
}

/**
 * Wind displacement.
 *
 * Two travelling waves at different scales plus a high-frequency flutter: the
 * large one moves whole patches together so a field reads as gusts crossing it,
 * and the small one keeps neighbouring blades from moving in lockstep.
 */
vec3 windDisplacement(vec3 worldPos, float time, float strength) {
  float angle = SCENE_WIND_ANGLE;
  vec2 dir = vec2(cos(angle), sin(angle));
  float travel = dot(worldPos.xz, dir);

  float gust = sin(travel * 0.09 - time * 0.9) * 0.5 + 0.5;
  gust = gust * gust;

  float sway = sin(travel * 0.42 - time * 2.1);
  float flutter = sin(worldPos.x * 3.7 + worldPos.z * 2.9 - time * 7.3) * 0.28;

  float amount = strength * (0.06 + gust * 0.16) * (sway + flutter);
  return vec3(dir.x * amount, -abs(amount) * 0.22, dir.y * amount);
}

#endif

// Water surface vertex shader.
//
// The top face is displaced by a sum of Gerstner waves, evaluated in world
// space so neighbouring chunks stay continuous with no seam at the border.
//
// The *normal* used to come from the same evaluation, passed down as an
// interpolated varying — and that was the bug behind the long straight streaks
// on open water. Water tops are greedy-meshed, so an ocean is a handful of
// quads tens of blocks across; one wave gradient per corner, linearly
// interpolated between them, turns a wave field into a set of flat facets whose
// shading changes in straight lines along the quad edges. The fragment shader
// evaluates the gradient per pixel instead. Ten sines a pixel is nothing next
// to the noise the detail normal already runs, and it is the difference between
// water and corrugated metal.
//
// Displacement stays here — geometry has to move in the vertex stage — but its
// amplitude fades out with distance. Two reasons, both about seams: a merged
// quad only samples the wave at its corners, so displacement far away buys
// facets rather than waves; and where two sections meet at different levels of
// detail their corners fall on different world positions, so each lands on a
// different part of the wave and the surface tears open along the boundary.
// Those tears were the thin bright lines running across the sea.

#include "chunk/chunk_common.glsl"
#include "lib/noise.glsl"

uniform float uWaveAmplitude;
uniform int uWaveCount;
/** x = distance where displacement starts fading, y = where it is gone. */
uniform vec2 uWaveFade;

out vec3 vWorldPos;
out vec2 vUv;
out vec3 vLightAO;
out vec3 vWaterTint;
flat out float vTexLayer;
flat out vec3 vFaceNormal;
flat out float vIsSurface;

void main() {
  ChunkVertex v = decodeChunkVertex();
  vec3 worldPos = uChunkOrigin + v.localPos;

  vec3 faceNormal = FACE_NORMAL[v.face];
  // Only the upward face is displaced; the sides stay put so the water column
  // does not tear away from the block it fills.
  float isSurface = faceNormal.y > 0.5 ? 1.0 : 0.0;

  float distance = length(worldPos.xz - uCameraPos.xz);
  float displace = 1.0 - smoothstep(uWaveFade.x, uWaveFade.y, distance);

  vec3 waves = gerstnerWaves(
    worldPos.xz, SCENE_TIME, SCENE_WIND_ANGLE,
    uWaveAmplitude * (1.0 + SCENE_RAIN * 0.8), uWaveCount
  );

  worldPos.y += waves.x * isSurface * displace;

  vWorldPos = worldPos;
  vUv = v.uv;
  vTexLayer = float(v.texLayer);
  vFaceNormal = faceNormal;
  vIsSurface = isSurface;
  vLightAO = vec3(v.skyLight, v.blockLight, v.ao);
  vWaterTint = sampleTintAtlas(worldPos.xz, 2.0);

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}

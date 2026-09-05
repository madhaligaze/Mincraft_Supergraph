// Water surface vertex shader.
//
// The top face is displaced by a sum of Gerstner waves, evaluated in world
// space so neighbouring chunks stay continuous with no seam at the border. The
// same evaluation returns the surface gradient, so the normal comes out of the
// displacement rather than needing a second pass or finite differences.

#include "chunk/chunk_common.glsl"
#include "lib/noise.glsl"

uniform float uWaveAmplitude;
uniform int uWaveCount;

out vec3 vWorldPos;
out vec2 vUv;
out vec3 vLightAO;
out vec2 vWaveGradient;
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

  vec3 waves = gerstnerWaves(
    worldPos.xz, SCENE_TIME, SCENE_WIND_ANGLE,
    uWaveAmplitude * (1.0 + SCENE_RAIN * 0.8), uWaveCount
  );

  worldPos.y += waves.x * isSurface;

  vWorldPos = worldPos;
  vUv = v.uv;
  vTexLayer = float(v.texLayer);
  vFaceNormal = faceNormal;
  vIsSurface = isSurface;
  vWaveGradient = waves.yz;
  vLightAO = vec3(v.skyLight, v.blockLight, v.ao);
  vWaterTint = sampleTintAtlas(worldPos.xz, 2.0);

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}

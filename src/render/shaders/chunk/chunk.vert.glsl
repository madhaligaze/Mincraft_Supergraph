// Main chunk vertex shader (opaque, cutout and translucent buckets).

#include "chunk/chunk_common.glsl"

out vec3 vWorldPos;
out vec2 vUv;
out vec3 vTint;
out vec3 vLightAO;      // x = skylight, y = block light, z = vertex AO
flat out float vTexLayer;
// The face basis is constant across a quad, so it travels as flat varyings
// rather than being re-derived from an index in the fragment shader.
flat out vec3 vFaceNormal;
/** xyz = texture U axis in world space, w = UV handedness. */
flat out vec4 vFaceTangent;

void main() {
  ChunkVertex v = decodeChunkVertex();

  vec3 worldPos = uChunkOrigin + v.localPos;

  if (v.wind) {
    worldPos += windDisplacement(worldPos, SCENE_TIME, SCENE_WIND * (1.0 + SCENE_RAIN));
  }

  vWorldPos = worldPos;
  vUv = v.uv;
  vTexLayer = float(v.texLayer);
  vFaceNormal = FACE_NORMAL[v.face];
  vFaceTangent = vec4(FACE_TEX_U[v.face], FACE_UV_SIGN[v.face]);
  vTint = vertexTint(v.tintMode, worldPos.xz);
  vLightAO = vec3(v.skyLight, v.blockLight, v.ao);

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}

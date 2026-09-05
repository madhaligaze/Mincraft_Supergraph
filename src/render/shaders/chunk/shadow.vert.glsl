// Shadow cascade vertex shader. One draw per cascade layer.

#include "chunk/chunk_common.glsl"

uniform mat4 uLightViewProj;

out vec2 vUv;
flat out float vTexLayer;

void main() {
  ChunkVertex v = decodeChunkVertex();
  vec3 worldPos = uChunkOrigin + v.localPos;

  if (v.wind) {
    worldPos += windDisplacement(worldPos, SCENE_TIME, SCENE_WIND * (1.0 + SCENE_RAIN));
  }

  vUv = v.uv;
  vTexLayer = float(v.texLayer);

  gl_Position = uLightViewProj * vec4(worldPos, 1.0);
}

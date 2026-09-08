// The block being mined: a cube one hair larger than the block itself, so the
// cracks sit on top of the face instead of fighting it for depth.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/cube.glsl"

uniform vec3 uBlockPos;
uniform float uInflate;

out vec2 vUv;
flat out int vFace;

void main() {
  vec3 normal;
  vec2 corner;
  int face;
  vec3 local = cubeVertex(gl_VertexID, normal, corner, face);

  vec3 world = uBlockPos + 0.5 + local * (1.0 + uInflate);

  vUv = corner;
  vFace = face;
  gl_Position = uViewProj * vec4(world, 1.0);
}

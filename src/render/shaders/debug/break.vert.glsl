// The block being mined: a cube one hair larger than the block itself, so the
// cracks sit on top of the face instead of fighting it for depth.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform vec3 uBlockPos;
uniform float uInflate;

out vec2 vUv;
flat out int vFace;

const vec3 FACE_N[6] = vec3[6](
  vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0),
  vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)
);
const vec3 FACE_U[6] = vec3[6](
  vec3(0, 0, -1), vec3(0, 0, 1), vec3(1, 0, 0),
  vec3(1, 0, 0), vec3(1, 0, 0), vec3(-1, 0, 0)
);
const vec3 FACE_V[6] = vec3[6](
  vec3(0, 1, 0), vec3(0, 1, 0), vec3(0, 0, 1),
  vec3(0, 0, -1), vec3(0, 1, 0), vec3(0, 1, 0)
);
const vec2 CORNERS[6] = vec2[6](
  vec2(0, 0), vec2(1, 0), vec2(1, 1),
  vec2(0, 0), vec2(1, 1), vec2(0, 1)
);

void main() {
  int face = gl_VertexID / 6;
  vec2 corner = CORNERS[gl_VertexID % 6];

  vec3 local = FACE_N[face] * 0.5 + FACE_U[face] * (corner.x - 0.5) +
    FACE_V[face] * (corner.y - 0.5);

  vec3 world = uBlockPos + 0.5 + local * (1.0 + uInflate);

  vUv = corner;
  vFace = face;
  gl_Position = uViewProj * vec4(world, 1.0);
}

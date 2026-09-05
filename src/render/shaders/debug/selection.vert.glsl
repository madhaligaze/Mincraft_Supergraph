// Block selection outline: twelve edges of a unit cube, generated from
// gl_VertexID so no vertex buffer is needed.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform vec3 uBlockPos;
uniform float uInflate;

/** Endpoints of the 12 cube edges, as 24 corner indices. */
const int EDGES[24] = int[24](
  0, 1, 1, 3, 3, 2, 2, 0,
  4, 5, 5, 7, 7, 6, 6, 4,
  0, 4, 1, 5, 2, 6, 3, 7
);

void main() {
  int corner = EDGES[gl_VertexID];
  vec3 local = vec3(
    float(corner & 1),
    float((corner >> 2) & 1),
    float((corner >> 1) & 1)
  );

  // Inflate slightly so the outline never z-fights with the block face.
  vec3 world = uBlockPos + (local - 0.5) * (1.0 + uInflate) + 0.5;
  gl_Position = uViewProj * vec4(world, 1.0);
}

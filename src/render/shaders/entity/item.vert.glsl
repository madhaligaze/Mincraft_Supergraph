// Dropped items.
//
// One instanced draw for every item lying in the world. Two shapes come out of
// the same program: a small textured cube for a block, and a camera-facing quad
// for everything that is not a block — a stick has no cube form, and inventing
// one would read as a mistake rather than as a stick.
//
// The cube is generated from gl_VertexID; there is no vertex buffer, only the
// per-instance stream.

#include "lib/common.glsl"
#include "lib/scene.glsl"

/** xyz = world position of the item's centre, w = spin in radians. */
layout(location = 0) in vec4 iPosSpin;
/** rgb = tint, w = edge length in blocks. */
layout(location = 1) in vec4 iTintScale;
/** x = side layer, y = top layer (or icon layer), z = skylight, w = blocklight. */
layout(location = 2) in vec4 iLayers;

/** 0 draws cubes (36 vertices), 1 draws sprites (6). */
uniform int uSprite;

out vec3 vWorldPos;
out vec2 vUv;
out vec3 vTint;
flat out vec3 vNormal;
flat out float vLayer;
flat out vec2 vLight;

/** Faces in the engine's usual order: +X, -X, +Y, -Y, +Z, -Z. */
const vec3 FACE_N[6] = vec3[6](
  vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0),
  vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)
);

/** u × v = n for every face, so the quad winds counter-clockwise from outside. */
const vec3 FACE_U[6] = vec3[6](
  vec3(0, 0, -1), vec3(0, 0, 1), vec3(1, 0, 0),
  vec3(1, 0, 0), vec3(1, 0, 0), vec3(-1, 0, 0)
);
const vec3 FACE_V[6] = vec3[6](
  vec3(0, 1, 0), vec3(0, 1, 0), vec3(0, 0, 1),
  vec3(0, 0, -1), vec3(0, 1, 0), vec3(0, 1, 0)
);

/** Two triangles as six corners of the unit square. */
const vec2 CORNERS[6] = vec2[6](
  vec2(0, 0), vec2(1, 0), vec2(1, 1),
  vec2(0, 0), vec2(1, 1), vec2(0, 1)
);

void main() {
  vTint = iTintScale.rgb;
  vLight = iLayers.zw;

  float spin = iPosSpin.w;
  float cs = cos(spin);
  float sn = sin(spin);

  vec3 world;

  if (uSprite == 1) {
    // Camera basis straight out of the view matrix rows: the quad has to face
    // the camera, not the sun, and reconstructing it here costs nothing.
    vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
    vec3 normal = normalize(cross(right, up));

    vec2 corner = CORNERS[gl_VertexID] - 0.5;
    float scale = iTintScale.w * 1.55;
    world = iPosSpin.xyz + (right * corner.x + up * corner.y) * scale;

    vUv = vec2(CORNERS[gl_VertexID].x, 1.0 - CORNERS[gl_VertexID].y);
    vNormal = normal;
    vLayer = iLayers.y;
  } else {
    int face = gl_VertexID / 6;
    vec2 corner = CORNERS[gl_VertexID % 6];

    vec3 n = FACE_N[face];
    vec3 u = FACE_U[face];
    vec3 v = FACE_V[face];

    vec3 local = (n * 0.5 + u * (corner.x - 0.5) + v * (corner.y - 0.5)) * iTintScale.w;
    // Spin about the vertical axis, which is the only rotation an item has.
    vec3 spun = vec3(local.x * cs - local.z * sn, local.y, local.x * sn + local.z * cs);
    vec3 spunN = vec3(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs);

    world = iPosSpin.xyz + spun;
    vUv = corner;
    vNormal = spunN;
    // Top and bottom faces use the block's top texture; the sides its side one.
    vLayer = (face == 2 || face == 3) ? iLayers.y : iLayers.x;
  }

  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}

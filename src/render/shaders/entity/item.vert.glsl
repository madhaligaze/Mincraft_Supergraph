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
/**
 * x = pitch about X, y = roll about Z, zw unused.
 *
 * Only the item in the player's hand uses this. A dropped item spins about the
 * vertical and nothing else, but a held block sits at an angle — that tilt is
 * most of what makes it read as "in a hand" rather than "floating".
 */
layout(location = 3) in vec4 iTilt;

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
/**
 * Chosen so that u × v equals the face normal for **every** face.
 *
 * The top and bottom rows used to be the other way round, which made their
 * winding clockwise from outside — so back-face culling threw them away and a
 * dropped block was drawn as four side faces with no lid. It reads as a flat
 * plate rather than a cube, which is exactly how the item in the player's hand
 * looked until this line was checked with a cross product instead of an eye.
 */
const vec3 FACE_V[6] = vec3[6](
  vec3(0, 1, 0), vec3(0, 1, 0), vec3(0, 0, -1),
  vec3(0, 0, 1), vec3(0, 1, 0), vec3(0, 1, 0)
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

    // Tilt first, spin second, and the order is the whole trick.
    //
    // The tilt axes are the object's own, so applying them *before* the yaw
    // makes them turn with it: for the item in the player's hand, whose yaw
    // follows the camera, that puts the pitch on the camera's right axis and
    // the roll on its forward one. Tilting after the yaw instead rotates about
    // fixed world axes, and the held block reads as a flat plate from one
    // heading and as a cube from another.
    float cr = cos(iTilt.y), sr = sin(iTilt.y);
    vec3 p = vec3(local.x * cr - local.y * sr, local.x * sr + local.y * cr, local.z);
    vec3 pn = vec3(n.x * cr - n.y * sr, n.x * sr + n.y * cr, n.z);

    float cp = cos(iTilt.x), sp = sin(iTilt.x);
    p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
    pn = vec3(pn.x, pn.y * cp - pn.z * sp, pn.y * sp + pn.z * cp);

    vec3 spun = vec3(p.x * cs - p.z * sn, p.y, p.x * sn + p.z * cs);
    vec3 spunN = vec3(pn.x * cs - pn.z * sn, pn.y, pn.x * sn + pn.z * cs);

    world = iPosSpin.xyz + spun;
    vUv = corner;
    vNormal = spunN;
    // Top and bottom faces use the block's top texture; the sides its side one.
    vLayer = (face == 2 || face == 3) ? iLayers.y : iLayers.x;
  }

  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}

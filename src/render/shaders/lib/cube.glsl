// One cube, generated from gl_VertexID, shared by everything that draws one.
//
// This file exists because the table below was written out twice — in the
// dropped-item shader and in the break-cracks shader — and one of the copies
// had the top and bottom rows swapped. `u × v` came out as *minus* the normal
// there, so those two faces wound clockwise when seen from outside, back-face
// culling threw them away, and every dropped block was drawn as a box with no
// lid. It read as a flat plate and was blamed on the camera angle for months.
//
// The invariant is one line of arithmetic, and it is worth stating out loud:
//
//     FACE_U[f] × FACE_V[f] == FACE_N[f]   for every f
//
// With that true, the corner order below winds counter-clockwise seen from
// outside the cube, which is what `gl.CULL_FACE` with the default front face
// expects. Verified in `scripts/facecheck.mjs`, which reads this file.

#ifndef LIB_CUBE
#define LIB_CUBE

/** Faces in the engine's usual order: +X, -X, +Y, -Y, +Z, -Z. */
const vec3 FACE_N[6] = vec3[6](
  vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0),
  vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)
);

const vec3 FACE_U[6] = vec3[6](
  vec3(0, 0, -1), vec3(0, 0, 1), vec3(1, 0, 0),
  vec3(1, 0, 0), vec3(1, 0, 0), vec3(-1, 0, 0)
);

const vec3 FACE_V[6] = vec3[6](
  vec3(0, 1, 0), vec3(0, 1, 0), vec3(0, 0, -1),
  vec3(0, 0, 1), vec3(0, 1, 0), vec3(0, 1, 0)
);

/** Two triangles as six corners of the unit square. */
const vec2 CUBE_CORNERS[6] = vec2[6](
  vec2(0, 0), vec2(1, 0), vec2(1, 1),
  vec2(0, 0), vec2(1, 1), vec2(0, 1)
);

/**
 * One vertex of a unit cube centred on the origin.
 *
 * `vertexId` runs 0..35: six vertices per face, faces in the order above.
 * `outNormal` and `outUv` come back alongside because every caller needs them
 * and recomputing the face index twice is how the two get out of step.
 */
vec3 cubeVertex(int vertexId, out vec3 outNormal, out vec2 outUv, out int outFace) {
  int face = vertexId / 6;
  vec2 corner = CUBE_CORNERS[vertexId % 6];

  outFace = face;
  outNormal = FACE_N[face];
  outUv = corner;

  return FACE_N[face] * 0.5
    + FACE_U[face] * (corner.x - 0.5)
    + FACE_V[face] * (corner.y - 0.5);
}

#endif

// Vertex shader for every fullscreen pass.
//
// Draws one oversized triangle from gl_VertexID with no vertex buffer bound:
// vertices (-1,-1), (3,-1), (-1,3). A single triangle avoids the diagonal seam
// and the duplicated quad-shading along the shared edge that two triangles
// would cost.
//
// Depth is emitted at the reversed-Z far plane (0), so a fullscreen pass with
// GEQUAL depth testing covers only pixels nothing has written yet.

out vec2 vUv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}

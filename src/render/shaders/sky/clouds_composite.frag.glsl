// Composites the quarter-resolution cloud buffer over the sky.
//
// Occlusion is handled by the depth test, not by sampling the depth buffer:
// this pass renders into the same framebuffer the depth texture is attached
// to, and reading an attachment of the framebuffer you are drawing into is
// undefined behaviour. Drawing at the reversed-Z far plane with GEQUAL gives
// the identical result — the test passes only where nothing has been drawn —
// and it costs one comparison instead of a texture fetch.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform sampler2D uClouds;
uniform vec2 uCloudTexel;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // 2x2 dilated tap: softens the edge where the low-resolution cloud buffer
  // meets a silhouette without paying for a full bilateral filter.
  vec2 o = uCloudTexel * 0.5;
  vec4 c0 = texture(uClouds, vUv + vec2(-o.x, -o.y));
  vec4 c1 = texture(uClouds, vUv + vec2( o.x, -o.y));
  vec4 c2 = texture(uClouds, vUv + vec2(-o.x,  o.y));
  vec4 c3 = texture(uClouds, vUv + vec2( o.x,  o.y));
  vec4 clouds = (c0 + c1 + c2 + c3) * 0.25;

  // rgb is already premultiplied in-scattering, a is the layer transmittance,
  // so the blend is a straight over-operator: ONE, SRC_ALPHA.
  fragColor = vec4(clouds.rgb, clouds.a);
}

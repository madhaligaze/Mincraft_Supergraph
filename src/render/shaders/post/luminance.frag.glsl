// First step of the auto-exposure reduction: scene colour -> log luminance.
//
// Log space is what makes the average meaningful. A linear average is dominated
// by the sun and by specular highlights, so the exposure would swing wildly as
// a glint crosses the frame; the geometric mean that log space produces tracks
// what the scene actually looks like.

#include "lib/common.glsl"

uniform sampler2D uScene;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 color = texture(uScene, vUv).rgb;
  float lum = max(luminance(color), 1e-5);
  // Clamp the top end so the sun disc cannot pull the whole frame dark.
  fragColor = vec4(log(min(lum, 90.0)), 0.0, 0.0, 1.0);
}

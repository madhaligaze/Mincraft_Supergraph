// Adds the quarter-resolution light shafts back into the frame.
//
// Separate from the march because that one reads the scene depth, and the
// scene depth is attached to the framebuffer this writes into: a shader may not
// read a texture bound to its own target. The march therefore renders to its
// own small target, and this blends the result up.

#include "lib/common.glsl"

uniform sampler2D uShafts;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Bilinear magnification is the blur: a beam has no detail to lose, and a
  // wider filter here would only smear it into the geometry in front of it.
  fragColor = vec4(texture(uShafts, vUv).rgb, 1.0);
}

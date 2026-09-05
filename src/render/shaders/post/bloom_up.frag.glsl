// Bloom upsample with a 3x3 tent filter, additively blended onto the level
// above. Progressive upsampling like this produces a wide, smooth glow from a
// short mip chain, which is much cheaper than a single large-radius blur.

#include "lib/common.glsl"

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uRadius;

in vec2 vUv;
out vec4 fragColor;

vec3 fetch(vec2 offset) {
  return texture(uSource, vUv + offset * uTexel * uRadius).rgb;
}

void main() {
  vec3 result = fetch(vec2(0.0, 0.0)) * 4.0;
  result += (fetch(vec2(-1.0, 0.0)) + fetch(vec2(1.0, 0.0)) +
             fetch(vec2(0.0, -1.0)) + fetch(vec2(0.0, 1.0))) * 2.0;
  result += fetch(vec2(-1.0, -1.0)) + fetch(vec2(1.0, -1.0)) +
            fetch(vec2(-1.0, 1.0)) + fetch(vec2(1.0, 1.0));
  fragColor = vec4(result * (1.0 / 16.0), 1.0);
}

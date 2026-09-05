// Reduction step: averages a 4x4 neighbourhood down to one texel.
//
// Four bilinear taps placed between texels read sixteen samples, so the whole
// chain from 64x64 to 1x1 is three passes of four fetches each.

uniform sampler2D uSource;
uniform vec2 uTexel;

in vec2 vUv;
out vec4 fragColor;

void main() {
  float sum =
    texture(uSource, vUv + vec2(-1.0, -1.0) * uTexel).r +
    texture(uSource, vUv + vec2( 1.0, -1.0) * uTexel).r +
    texture(uSource, vUv + vec2(-1.0,  1.0) * uTexel).r +
    texture(uSource, vUv + vec2( 1.0,  1.0) * uTexel).r;
  fragColor = vec4(sum * 0.25, 0.0, 0.0, 1.0);
}

// Bloom downsample.
//
// The 13-tap pattern from Jimenez's SIGGRAPH 2014 talk, with Karis' partial
// averaging on the first level. Two details matter and both are about
// stability: the 13 taps remove the pulsing a naive box filter produces as the
// camera moves, and the karis weighting stops one very bright pixel from
// blowing up into a flickering blob.

#include "lib/common.glsl"

uniform sampler2D uSource;
uniform vec2 uTexel;
/** Applied only on the first downsample. */
uniform float uKarisAverage;
uniform float uThreshold;
uniform float uSoftKnee;

in vec2 vUv;
out vec4 fragColor;

vec3 fetch(vec2 offset) {
  return texture(uSource, vUv + offset * uTexel).rgb;
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luminance(c));
}

void main() {
  vec3 a = fetch(vec2(-2.0,  2.0));
  vec3 b = fetch(vec2( 0.0,  2.0));
  vec3 c = fetch(vec2( 2.0,  2.0));
  vec3 d = fetch(vec2(-2.0,  0.0));
  vec3 e = fetch(vec2( 0.0,  0.0));
  vec3 f = fetch(vec2( 2.0,  0.0));
  vec3 g = fetch(vec2(-2.0, -2.0));
  vec3 h = fetch(vec2( 0.0, -2.0));
  vec3 i = fetch(vec2( 2.0, -2.0));

  vec3 j = fetch(vec2(-1.0,  1.0));
  vec3 k = fetch(vec2( 1.0,  1.0));
  vec3 l = fetch(vec2(-1.0, -1.0));
  vec3 m = fetch(vec2( 1.0, -1.0));

  vec3 result;
  if (uKarisAverage > 0.5) {
    // Each 2x2 group is averaged with luminance weighting before the groups
    // are combined, which is what makes the filter fireflies-resistant.
    vec3 g0 = (a + b + d + e) * 0.25;
    vec3 g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25;
    vec3 g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;

    float w0 = karisWeight(g0) * 0.125;
    float w1 = karisWeight(g1) * 0.125;
    float w2 = karisWeight(g2) * 0.125;
    float w3 = karisWeight(g3) * 0.125;
    float w4 = karisWeight(g4) * 0.5;
    float wSum = w0 + w1 + w2 + w3 + w4;

    result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(wSum, 1e-5);

    // Soft-knee threshold, applied once on the way in.
    float brightness = maxComponent(result);
    float knee = uThreshold * uSoftKnee;
    float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-5);
    result *= contribution;
  } else {
    result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
  }

  fragColor = vec4(result, 1.0);
}

// Rain and snow particles: additive streaks tinted by the sky, so a downpour
// at sunset picks up the same orange the rest of the scene has.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/sky_sample.glsl"

uniform float uSnow;

in vec2 vUv;
in float vFade;

out vec4 fragColor;

void main() {
  if (vFade <= 0.005) discard;

  float mask;
  if (uSnow > 0.5) {
    // Round, soft flake.
    float d = length(vUv - 0.5) * 2.0;
    mask = smoothstep(1.0, 0.15, d);
  } else {
    // Thin streak, tapered at both ends.
    float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float along = smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
    mask = smoothstep(0.0, 0.85, across) * along;
  }
  if (mask <= 0.01) discard;

  vec3 skyColor = sampleSkyView(vec3(0.0, 0.7, 0.0));
  vec3 color = mix(skyColor * 1.3, vec3(1.0), uSnow * 0.5);

  fragColor = vec4(color * mask * vFade * (uSnow > 0.5 ? 0.85 : 0.35), mask * vFade);
}

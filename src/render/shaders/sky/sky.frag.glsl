// Draws the sky dome into the HDR scene target.
//
// Runs after opaque geometry with GEQUAL depth testing at the far plane, so it
// only touches pixels no surface has claimed. That ordering means the sky costs
// nothing where the terrain already covers the screen — on a forest floor most
// of the frame is skipped entirely.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/sky_sample.glsl"
#include "lib/noise.glsl"

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 dir = viewRayFromUv(vUv);

  // Shares `atmosphereColor` with the fog, so the band where distant terrain
  // gives way to empty sky is continuous instead of a visible seam.
  vec3 color = atmosphereColor(dir);
  color += starField(dir, uMoonColor.a);
  color += celestialBodies(dir);

  fragColor = vec4(color, 1.0);
}

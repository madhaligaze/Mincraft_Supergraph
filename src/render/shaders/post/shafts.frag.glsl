// Volumetric light shafts.
//
// The last item of the original brief. The reference screenshot of a sunrise
// over water has beams standing between the trees, and everything else in that
// description — low sun, physical sky, reflective water, volumetric haze, dense
// grass, soft shadows — was built long before this.
//
// The idea is small: march the view ray, ask the shadow cascades at each step
// whether that point in the air is lit, and add up what is. A lit point in air
// scatters some sunlight towards the camera; an unlit one does not. That
// difference *is* the beam.
//
// Runs at quarter resolution because the result is low-frequency, and the beams
// are then blurred by the upsample rather than in spite of it. Steps are offset
// per pixel by a dither so that eight of them read as a smooth wedge instead of
// eight slices.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/shadow.glsl"
#include "lib/sky_sample.glsl"

uniform sampler2D uSceneDepth;
/** How far the march goes, in blocks. */
uniform float uRange;
/** Overall brightness of the effect. */
uniform float uStrength;

#ifndef SHAFT_STEPS
#define SHAFT_STEPS 10
#endif

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Nothing to scatter when the sun is down.
  if (uSunDirection.w <= 0.001) { fragColor = vec4(0.0); return; }

  float depth = texture(uSceneDepth, vUv).r;
  vec3 ray = viewRayFromUv(vUv);

  // Depth 0 is the sky: march the full range through open air.
  float distance = depth > 0.0
    ? min(length(worldFromDepth(vUv, depth) - uCameraPos.xyz), uRange)
    : uRange;
  if (distance < 1.0) { fragColor = vec4(0.0); return; }

  // Mie scattering is strongly forward: the beams are bright when looking
  // towards the sun and almost absent with it behind you, which is exactly
  // what the eye expects and what makes the effect read as air rather than fog.
  float cosAngle = dot(ray, uSunDirection.xyz);
  float g = 0.62;
  float phase = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * cosAngle, 1.5));

  float stepSize = distance / float(SHAFT_STEPS);
  // Per-pixel offset along the ray. Without it the steps land on the same
  // depths across the screen and the beam comes out as banded slabs.
  float offset = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME);

  float lit = 0.0;
  for (int i = 0; i < SHAFT_STEPS; i++) {
    float t = (float(i) + offset) * stepSize;
    vec3 position = uCameraPos.xyz + ray * t;

    // The normal argument only feeds the normal offset, which exists to stop a
    // surface shadowing itself; a point in mid-air has no surface, so the sun
    // direction is the harmless choice.
    lit += sampleShadow(position, uSunDirection.xyz, 1.0, t, 0.0, 1);
  }

  // Density falls off with height the same way the aerial perspective's does:
  // beams live in the haze near the ground, not in the stratosphere.
  float height = uCameraPos.y + ray.y * distance * 0.5;
  float density = exp(-max(height - uSeaLevel, 0.0) * 0.012);

  vec3 sunColor = uSunColor.rgb * uSunDirection.w;
  float amount = (lit / float(SHAFT_STEPS)) * phase * density * uStrength *
    min(distance / uRange, 1.0);

  fragColor = vec4(sunColor * amount, 1.0);
}

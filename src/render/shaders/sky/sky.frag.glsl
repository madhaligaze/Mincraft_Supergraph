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

/**
 * The sea beyond the render distance.
 *
 * Chunks stop at a few hundred blocks and everything past that was empty sky,
 * dimmed a little below the horizon. Seen from the ground that reads as haze
 * and passes; seen from any height it is a flat grey wall standing where the
 * world ends, and the world plainly ending is what "no depth" looks like.
 *
 * This is not more world — it is one ray-plane intersection at sea level, shot
 * only where the frame has no geometry at all, which is exactly the region that
 * used to be blank. Cost is a couple of texture fetches on pixels that were
 * already being touched by the sky pass. What it buys is a horizon: the ocean
 * carries on to a real vanishing line, aerial perspective has something to work
 * on, and the eye gets the distance cue the empty wall denied it.
 *
 * It cannot invent land, so a coastline still ends. But this world is mostly
 * water, and water is what the eye expects to find at a far horizon anyway.
 */
vec3 distantSea(vec3 dir, float startDistance, out float coverage) {
  coverage = 0.0;

  float height = uCameraPos.y - uSeaLevel;
  // Below the surface, or looking up: nothing to hit.
  if (height <= 0.5 || dir.y >= -0.0005) return vec3(0.0);

  float distance = height / -dir.y;
  if (distance <= startDistance) return vec3(0.0);

  vec3 hit = uCameraPos.xyz + dir * distance;

  // A flat mirror. At this range a wave is far under a pixel, so any normal
  // detail here would be aliasing rather than shape — the same reason the water
  // shader drops its short waves with distance.
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 reflected = vec3(dir.x, -dir.y, dir.z);
  vec3 reflection = sampleSkyView(reflected);

  // Schlick against water's F0. Grazing angles are almost all of this surface,
  // so it is nearly all reflection — which is precisely why a distant sea is
  // the colour of the sky above it rather than the colour of water.
  float NoV = saturate(dot(up, -dir));
  float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  // What little is not reflected: the body of the water, lit from above.
  const vec3 DEEP = vec3(0.055, 0.14, 0.17);
  vec3 body = DEEP * skyZenithRadiance();

  vec3 color = mix(body, reflection, fresnel);

  // The sun's road across the water. Broad, because roughness widens with
  // distance and this is all distance.
  vec3 H = normalize(-dir + uSunDirection.xyz);
  float NoH = saturate(dot(up, H));
  color += uSunColor.rgb * uSunDirection.w * pow(NoH, 220.0) * 0.9 *
    saturate(uSunDirection.y * 6.0);

  color = applyAerialPerspective(color, hit, dir, distance);

  // The fade band is wide, and that is not cosmetic. The set of points at a
  // fixed distance on a plane below the camera is a circle on screen, so a
  // narrow ramp draws a visible ring across the frame — which is exactly what a
  // ramp tied to the render distance did from any height. Starting close and
  // fading over a long way spreads that circle into a gradient nobody reads as
  // an edge. The near cutoff only exists so a chunk that has not streamed in
  // yet does not get an ocean painted under the player's feet.
  coverage = smoothstep(startDistance, startDistance * 4.0, distance);
  return color;
}

void main() {
  vec3 dir = viewRayFromUv(vUv);

  // Shares `atmosphereColor` with the fog, so the band where distant terrain
  // gives way to empty sky is continuous instead of a visible seam.
  vec3 color = atmosphereColor(dir);
  color += starField(dir, uMoonColor.a);
  color += celestialBodies(dir);

  float coverage;
  vec3 sea = distantSea(dir, 40.0, coverage);
  color = mix(color, sea, coverage);

  fragColor = vec4(color, 1.0);
}

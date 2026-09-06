// Screen-space reflection.
//
// Written for water and reused by wet ground, which is why the samplers and
// the step count are parameters rather than uniforms: the two callers bind
// different textures and want different budgets.

#ifndef SSR_GLSL
#define SSR_GLSL

#include "lib/scene.glsl"

/**
 * Marches a reflection ray against the depth buffer.
 *
 * The march is in **world space**, reprojected each step, which keeps the step
 * size uniform in the scene rather than in screen space — a screen-space march
 * takes huge world steps near the horizon and microscopic ones underfoot.
 *
 * Returns false when the ray leaves the frustum or finds nothing, and the
 * caller falls back to the sky. `confidence` fades at the screen edges, where
 * a reflection has no data to draw from.
 */
bool traceScreenReflection(
  sampler2D sceneColor, sampler2D sceneDepth,
  vec3 origin, vec3 dir, int steps,
  out vec3 hitColor, out float confidence
) {
  hitColor = vec3(0.0);
  confidence = 0.0;
  if (steps <= 0) return false;

  // Longer steps far away, short steps near the surface where detail matters.
  float stepSize = 0.55;
  vec3 position = origin;
  float previousDelta = 0.0;

  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;

    position += dir * stepSize;
    stepSize *= 1.14;

    vec4 clip = uViewProj * vec4(position, 1.0);
    if (clip.w <= 0.0) return false;
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;

    float depth = texture(sceneDepth, uv).r;
    if (depth <= 0.0) continue; // sky: keep marching

    // Reversed-Z: a larger depth value is nearer.
    float rayDepth = ndc.z * 0.5 + 0.5;
    float delta = rayDepth - depth;

    if (delta < 0.0 && previousDelta >= 0.0 && i > 0) {
      // Crossed the surface: refine with a few bisection steps. Three is
      // enough at this step size — each one is a dependent texture fetch.
      vec3 lo = position - dir * stepSize;
      vec3 hi = position;
      for (int k = 0; k < 3; k++) {
        vec3 mid = (lo + hi) * 0.5;
        vec4 midClip = uViewProj * vec4(mid, 1.0);
        vec3 midNdc = midClip.xyz / midClip.w;
        vec2 midUv = midNdc.xy * 0.5 + 0.5;
        float midScene = texture(sceneDepth, midUv).r;
        if ((midNdc.z * 0.5 + 0.5) - midScene < 0.0) hi = mid;
        else lo = mid;
      }

      vec4 finalClip = uViewProj * vec4(hi, 1.0);
      vec2 finalUv = (finalClip.xy / finalClip.w) * 0.5 + 0.5;

      // Reject hits far behind the surface: those are geometry the ray passed
      // through, not something it actually reflected off.
      float finalScene = texture(sceneDepth, finalUv).r;
      float thickness = abs(
        linearDepth(finalScene) - linearDepth(finalClip.z / finalClip.w * 0.5 + 0.5)
      );
      if (thickness > 4.0) return false;

      hitColor = texture(sceneColor, finalUv).rgb;
      // Fade out near the screen edges, where the reflection has no data.
      vec2 edge = smoothstep(vec2(0.0), vec2(0.14), finalUv) *
                  smoothstep(vec2(0.0), vec2(0.14), 1.0 - finalUv);
      confidence = edge.x * edge.y;
      return confidence > 0.01;
    }
    previousDelta = delta;
  }
  return false;
}

#endif

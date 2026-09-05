// Water shading.
//
// Four things carry the look, in order of importance:
//   1. Fresnel — nearly all reflection at grazing angles, nearly all refraction
//      looking straight down. Get this wrong and water reads as coloured glass.
//   2. Beer-Lambert absorption through the water column, so shallows show the
//      sand under them and depth goes green-blue on its own.
//   3. A screen-space reflection of the actual scene, falling back to the sky
//      LUT when the ray leaves the screen — which is most of the time, and is
//      why the fallback has to be the real sky rather than a constant.
//   4. A GGX sun highlight on the wave normals. This is the sun-glitter path in
//      the reference screenshots.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/pbr.glsl"
#include "lib/noise.glsl"
#include "lib/shadow.glsl"
#include "lib/sky_sample.glsl"

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;

uniform float uWaveAmplitude;
/** 0 disables screen-space reflection and uses the sky alone. */
uniform int uSsrSteps;
/**
 * Distance beyond which screen-space reflection is skipped entirely.
 *
 * Ray marching costs ~20 dependent texture fetches per pixel, and when an ocean
 * fills half the frame that was over 100 ms on its own. Far water reflects
 * almost nothing but sky, which the fallback already provides for free, so the
 * cutoff is invisible and pays for the whole feature.
 */
uniform float uSsrDistance;
uniform float uRefractionStrength;

#ifndef SHADOW_QUALITY
#define SHADOW_QUALITY 2
#endif

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vLightAO;
in vec2 vWaveGradient;
in vec3 vWaterTint;
flat in float vTexLayer;
flat in vec3 vFaceNormal;
flat in float vIsSurface;

out vec4 fragColor;

/** Two scrolling noise fields give the fine ripple the Gerstner sum cannot. */
vec3 detailNormal(vec2 pos, float time) {
  vec2 dirA = vec2(cos(SCENE_WIND_ANGLE), sin(SCENE_WIND_ANGLE));
  vec2 dirB = vec2(-dirA.y, dirA.x);

  float e = 0.35;
  vec2 pA = pos * 0.85 + dirA * time * 0.45;
  vec2 pB = pos * 1.9 - dirB * time * 0.28;

  // Two octaves, not three: this runs six times per pixel for the gradient,
  // so every octave costs twenty-four noise evaluations per water fragment.
  float h = fbm2(pA, 2) * 0.6 + fbm2(pB, 2) * 0.4;
  float hx = fbm2(pA + vec2(e, 0.0), 2) * 0.6 + fbm2(pB + vec2(e, 0.0), 2) * 0.4;
  float hz = fbm2(pA + vec2(0.0, e), 2) * 0.6 + fbm2(pB + vec2(0.0, e), 2) * 0.4;

  float scale = 1.4 + SCENE_RAIN * 2.2;
  return normalize(vec3(-(hx - h) * scale / e, 1.0, -(hz - h) * scale / e));
}

/**
 * Screen-space reflection.
 *
 * Marches in world space and reprojects each step, which keeps the step size
 * uniform in the scene rather than in screen space. Returns false when the ray
 * leaves the frustum or finds nothing, and the caller falls back to the sky.
 */
bool traceReflection(vec3 origin, vec3 dir, out vec3 hitColor, out float confidence) {
  hitColor = vec3(0.0);
  confidence = 0.0;
  if (uSsrSteps <= 0) return false;

  // Longer steps far away, short steps near the surface where detail matters.
  float stepSize = 0.55;
  vec3 position = origin;
  float previousDelta = 0.0;

  for (int i = 0; i < 64; i++) {
    if (i >= uSsrSteps) break;

    position += dir * stepSize;
    stepSize *= 1.14;

    vec4 clip = uViewProj * vec4(position, 1.0);
    if (clip.w <= 0.0) return false;
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;

    float sceneDepth = texture(uSceneDepth, uv).r;
    if (sceneDepth <= 0.0) continue; // sky: keep marching

    // Reversed-Z: a larger depth value is nearer.
    float rayDepth = ndc.z * 0.5 + 0.5;
    float delta = rayDepth - sceneDepth;

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
        float midScene = texture(uSceneDepth, midUv).r;
        if ((midNdc.z * 0.5 + 0.5) - midScene < 0.0) hi = mid;
        else lo = mid;
      }

      vec4 finalClip = uViewProj * vec4(hi, 1.0);
      vec2 finalUv = (finalClip.xy / finalClip.w) * 0.5 + 0.5;

      // Reject hits far behind the surface: those are geometry the ray passed
      // through, not something it actually reflected off.
      float finalScene = texture(uSceneDepth, finalUv).r;
      float thickness = abs(linearDepth(finalScene) - linearDepth(finalClip.z / finalClip.w * 0.5 + 0.5));
      if (thickness > 4.0) return false;

      hitColor = texture(uSceneColor, finalUv).rgb;
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

void main() {
  vec2 screenUv = gl_FragCoord.xy * uScreen.zw;

  vec3 toCamera = uCameraPos.xyz - vWorldPos;
  float viewDistance = length(toCamera);
  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 viewDir = -V;

  // --- normal ---
  vec3 N;
  // Blend detail out quickly with distance. Once a ripple is smaller than a
  // pixel the normal is pure noise, and a sharp specular lobe on top of noise
  // is the single worst source of shimmer in a scene like this. The branch
  // matters as much as the blend: the noise is ~70 hash evaluations, and most
  // of an ocean is past the fade.
  float detailFade = 1.0 - saturate((viewDistance - 10.0) / 46.0);
  if (vIsSurface > 0.5) {
    vec3 waveNormal = normalize(vec3(-vWaveGradient.x, 1.0, -vWaveGradient.y));
    if (detailFade > 0.01) {
      vec3 ripple = detailNormal(vWorldPos.xz, SCENE_TIME);
      N = normalize(mix(
        waveNormal,
        normalize(waveNormal + (ripple - vec3(0.0, 1.0, 0.0)) * 0.65),
        detailFade
      ));
    } else {
      N = waveNormal;
    }
  } else {
    N = vFaceNormal;
  }

  // --- what is behind the water ---
  float backgroundDepth = texture(uSceneDepth, screenUv).r;
  vec3 backgroundPos = worldFromDepth(screenUv, backgroundDepth);
  float waterColumn = backgroundDepth > 0.0
    ? max(0.0, distance(uCameraPos.xyz, backgroundPos) - viewDistance)
    : 40.0;

  // Refraction offset scales with how much water we are looking through, so a
  // shallow edge stays crisp and a deep body wobbles.
  vec2 refractOffset = N.xz * uRefractionStrength * saturate(waterColumn * 0.25) *
    (12.0 / max(viewDistance, 4.0)) * uScreen.zw * 40.0;
  vec2 refractUv = clamp(screenUv + refractOffset, vec2(0.001), vec2(0.999));

  // If the offset sample lands on something in front of the water, it would
  // bleed a foreground object into the refraction; fall back to the straight
  // sample in that case.
  float refractDepth = texture(uSceneDepth, refractUv).r;
  if (refractDepth > 0.0 && linearDepth(refractDepth) < viewDistance - 0.1) {
    refractUv = screenUv;
    refractDepth = backgroundDepth;
  }

  vec3 behind = texture(uSceneColor, refractUv).rgb;

  // Beer-Lambert: each channel is absorbed at its own rate, which is why deep
  // water goes blue-green rather than simply darker.
  vec3 absorption = (vec3(1.0) - vWaterTint) * vec3(0.42, 0.16, 0.11);
  vec3 transmitted = behind * exp(-absorption * waterColumn * 1.35);
  // Light scattered back out of the volume; this is what stops deep water from
  // turning into a black hole.
  vec3 scattered = vWaterTint * skyZenithRadiance() * 0.35;
  float scatterAmount = 1.0 - exp(-waterColumn * 0.11);
  vec3 refracted = mix(transmitted, scattered, scatterAmount * 0.85);

  // --- reflection ---
  vec3 R = reflect(viewDir, N);
  R.y = max(R.y, 0.008);
  vec3 skyReflection = sampleSkyView(R);
  // The mirrored sun disc is only worth its cost up close; further out the GGX
  // highlight below already draws the glitter path across the water.
  if (viewDistance < 90.0) skyReflection += celestialBodies(R);

  vec3 reflection = skyReflection;
  if (vIsSurface > 0.5 && viewDistance < uSsrDistance) {
    vec3 hitColor;
    float confidence;
    if (traceReflection(vWorldPos + N * 0.06, R, hitColor, confidence)) {
      // Fade the screen-space result out toward the cutoff so the transition
      // to the sky-only fallback is not a visible ring on the water.
      float rangeFade = 1.0 - smoothstep(uSsrDistance * 0.7, uSsrDistance, viewDistance);
      reflection = mix(skyReflection, hitColor, confidence * rangeFade);
    }
  }

  // --- fresnel ---
  float NoV = saturate(dot(N, V));
  // Schlick with water's F0 of 0.02.
  float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  fresnel = mix(fresnel, fresnel * 0.55, vIsSurface < 0.5 ? 1.0 : 0.0);

  vec3 color = mix(refracted, reflection, fresnel);

  // --- sun and moon glitter ---
  // Roughness widens with distance. This is the standard cure for specular
  // aliasing: as the sub-pixel normal variation the detail map used to carry
  // disappears into the filter, it is folded into the lobe width instead, so
  // distant water reads as a broad sheen rather than a field of white sparks.
  float baseRoughness = mix(0.012, 0.06, SCENE_RAIN);
  float roughness = mix(baseRoughness, 0.16, saturate((viewDistance - 14.0) / 110.0));
  roughness = max(roughness * roughness, 1e-5);

  // Shadows are only sampled on nearby water. Out on open ocean there is
  // nothing to cast them, and the six-tap filter was running on every pixel of
  // a sea that fills half the screen.
  float shadow = 1.0;
  if (viewDistance < uSsrDistance * 1.6) {
    float shadowRotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
    shadow = sampleShadow(
      vWorldPos, vec3(0.0, 1.0, 0.0), saturate(dot(N, uSunDirection.xyz)),
      viewDistance, shadowRotation, SHADOW_QUALITY
    );
  }
  shadow *= smoothstep(0.02, 0.35, vLightAO.x);

  if (uSunDirection.w > 0.001) {
    vec3 H = normalize(V + uSunDirection.xyz);
    float NoH = saturate(dot(N, H));
    float NoL = saturate(dot(N, uSunDirection.xyz));
    float D = D_GGX(NoH, roughness);
    float Vis = V_SmithGGXCorrelated(NoV + 1e-5, NoL, roughness);
    float F = F_Schlick(0.02, 1.0, saturate(dot(V, H)));
    color += uSunColor.rgb * uSunDirection.w * D * Vis * F * NoL * shadow;
  }

  if (uMoonDirection.w > 0.001) {
    vec3 H = normalize(V + uMoonDirection.xyz);
    float NoH = saturate(dot(N, H));
    float NoL = saturate(dot(N, uMoonDirection.xyz));
    color += uMoonColor.rgb * uMoonDirection.w *
      D_GGX(NoH, roughness * 3.0) * V_SmithGGXCorrelated(NoV + 1e-5, NoL, roughness * 3.0) *
      0.04 * NoL;
  }

  // --- shoreline foam ---
  // Where the bottom is close to the surface the water breaks up. Driving it
  // off the depth difference means foam follows the terrain automatically.
  float shore = 1.0 - saturate(waterColumn / 1.6);
  if (shore > 0.02 && vIsSurface > 0.5) {
    float foamNoise = fbm2(vWorldPos.xz * 2.6 + vec2(SCENE_TIME * 0.35), 2);
    float foam = smoothstep(0.42, 0.72, foamNoise * 0.55 + shore * 0.75);
    vec3 foamColor = uSunColor.rgb * uSunDirection.w * 0.35 + skyZenithRadiance() * 0.5;
    color = mix(color, foamColor, foam * shore * 0.8);
  }

  // --- rain ripples ---
  if (SCENE_RAIN > 0.01 && vIsSurface > 0.5) {
    float ripplePhase = fract(SCENE_TIME * 1.7 + hash12(floor(vWorldPos.xz * 1.5)));
    float ring = smoothstep(0.0, 0.06, ripplePhase) * (1.0 - ripplePhase);
    float d = fract(length(fract(vWorldPos.xz * 1.5) - 0.5) * 2.0);
    color += vec3(0.06) * ring * smoothstep(0.45, 0.5, d) * SCENE_RAIN;
  }

  color = applyAerialPerspective(color, vWorldPos, viewDir, viewDistance);

  // Alpha is only used at the very edge of a water body, where the surface
  // quad may stick out past the terrain it fills.
  float edgeAlpha = saturate(waterColumn * 4.0);
  fragColor = vec4(color, mix(0.55, 1.0, edgeAlpha));
}

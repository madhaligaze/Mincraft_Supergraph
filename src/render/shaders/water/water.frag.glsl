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
#include "lib/ssr.glsl"

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;

uniform float uWaveAmplitude;
uniform int uWaveCount;
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

/** Debug view 8 paints every pass a flat colour; see renderer.ts. */
uniform int uDebugView;
uniform vec3 uDebugBucket;

#ifndef SHADOW_QUALITY
#define SHADOW_QUALITY 2
#endif

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vLightAO;
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

/** Water's own wrapper around the shared march, with its budget. */
bool traceReflection(vec3 origin, vec3 dir, out vec3 hitColor, out float confidence) {
  return traceScreenReflection(
    uSceneColor, uSceneDepth, origin, dir, uSsrSteps, hitColor, confidence
  );
}

void main() {
  if (uDebugView == 8) {
    fragColor = vec4(uDebugBucket, 1.0);
    return;
  }

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
    // Evaluated here rather than interpolated from the vertex stage: see the
    // note in water.vert.glsl about greedy-meshed ocean quads.
    //
    // Waves are dropped from the sum with distance, shortest first. Each one is
    // a little under twice the frequency of the last, so the fifth has a
    // wavelength of about two blocks — at a hundred blocks out that is well
    // under a pixel, and a normal built from it is not shape but noise. That
    // noise, run through a sharp specular lobe, is what turned the far half of
    // an ocean into a field of black and white speckle. Dropping the term is
    // better than fading its amplitude: fading leaves the frequency in place
    // and only makes the aliasing quieter.
    int waveCount = int(mix(float(uWaveCount), 2.0,
      saturate((viewDistance - 24.0) / 80.0)));

    vec3 waves = gerstnerWaves(
      vWorldPos.xz, SCENE_TIME, SCENE_WIND_ANGLE,
      uWaveAmplitude * (1.0 + SCENE_RAIN * 0.8), waveCount
    );

    // The long swell flattens too, just much later: a twenty-block wave is
    // still shape at two hundred blocks, and a sheet is what the sea becomes
    // beyond that anyway.
    float swell = 1.0 - smoothstep(150.0, 380.0, viewDistance);
    vec3 waveNormal = normalize(vec3(-waves.y * swell, 1.0, -waves.z * swell));

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

  // --- shadow ---
  // Sampled here rather than just before the specular, because the volume
  // scattering below wants it too: water in the shadow of a cliff is darker all
  // the way down, not merely missing its highlight.
  //
  // Only on nearby water. Out on open ocean there is nothing to cast a shadow,
  // and the six-tap filter was running on every pixel of a sea that fills half
  // the screen.
  float shadow = 1.0;
  if (viewDistance < uSsrDistance * 1.6) {
    float shadowRotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
    shadow = sampleShadow(
      vWorldPos, vec3(0.0, 1.0, 0.0), saturate(dot(N, uSunDirection.xyz)),
      viewDistance, shadowRotation, SHADOW_QUALITY
    );
  }
  shadow *= smoothstep(0.02, 0.35, vLightAO.x);

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
  vec3 transmitted = behind * exp(-absorption * waterColumn * 1.1);

  // Light scattered back out of the volume.
  //
  // This is the only thing under the Fresnel reflection, so whatever it is, is
  // what the sea looks like wherever it is not mirroring the sky — which at a
  // shallow viewing angle means every wave trough. At 0.35 of the zenith
  // radiance it came to almost nothing, and the sea read as black troughs
  // between white crests instead of as water.
  //
  // Two corrections. The sun is in it now: the body colour of a sea at noon and
  // the body colour of the same sea at dusk are not the same, and the zenith
  // sky alone cannot tell them apart. And the overall level is up, because the
  // quantity being modelled is not the water's scattering albedo on its own but
  // the whole upwelling column — every metre of it lit from above.
  vec3 waterLight = skyZenithRadiance() * 0.9 +
    uSunColor.rgb * uSunDirection.w * saturate(uSunDirection.y) * 0.055;
  vec3 scattered = vWaterTint * waterLight * shadow;

  float scatterAmount = 1.0 - exp(-waterColumn * 0.13);
  vec3 refracted = mix(transmitted, scattered, scatterAmount * 0.88);

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

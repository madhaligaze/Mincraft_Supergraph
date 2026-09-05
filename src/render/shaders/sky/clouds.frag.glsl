// Volumetric clouds.
//
// Rendered at a quarter of the screen resolution into an RGBA16F target
// (rgb = in-scattered light, a = transmittance) and composited afterwards.
// Quarter resolution is not really a compromise: the phase function leaves no
// high-frequency detail to resolve, and it turns a pass that would cost 12 ms
// on a UHD 620 into one that costs about 2.
//
// Density comes from two baked 3D textures rather than analytic Worley noise.
// The analytic version was ~500 million hash evaluations per frame and, on its
// own, halved the frame rate; this version is a handful of texture fetches.
//
// The march is energy-conserving (Hillaire's analytic segment integration), so
// 20 steps look like 80, and the light march reuses the coverage value from the
// step it belongs to instead of recomputing it.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/atmosphere.glsl"
#include "lib/sky_sample.glsl"

/** R = Perlin-Worley base, GBA = Worley at rising frequencies. */
uniform sampler3D uCloudShape;
/** RGB = high-frequency Worley, for edge erosion. */
uniform sampler3D uCloudDetail;

uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudSpeed;

#ifndef MARCH_STEPS
#define MARCH_STEPS 24
#endif

#ifndef LIGHT_STEPS
#define LIGHT_STEPS 5
#endif

/** World-space tiling periods, in blocks. */
const float COVERAGE_PERIOD = 9000.0;
const float SHAPE_PERIOD = 2600.0;
const float DETAIL_PERIOD = 320.0;

in vec2 vUv;
out vec4 fragColor;

float remap(float value, float inLow, float inHigh, float outLow, float outHigh) {
  return outLow + (value - inLow) / max(inHigh - inLow, 1e-5) * (outHigh - outLow);
}

vec2 windOffset(float scale) {
  vec2 dir = vec2(cos(SCENE_WIND_ANGLE), sin(SCENE_WIND_ANGLE));
  return dir * SCENE_TIME * uCloudSpeed * scale;
}

/**
 * Large-scale coverage. One fetch of a low-frequency slice of the shape
 * texture, used as a 2D weather map.
 *
 * The mapping centres on the requested coverage rather than scaling a [0,1]
 * noise by it: coverage becomes the lower bound of the shape remap below, so a
 * mean of 0.2 would demand a base shape above 0.8 and the sky would come out
 * empty.
 */
float cloudCoverage(vec2 worldXZ) {
  vec2 uv = worldXZ / COVERAGE_PERIOD + windOffset(1.0 / COVERAGE_PERIOD) * 0.4;
  float noise = texture(uCloudShape, vec3(uv, 0.37)).r;
  return saturate((uCloudCoverage + SCENE_RAIN * 0.3) * (0.5 + noise * 1.15));
}

/** Rounded base, wispy top. */
float heightGradient(float heightFraction) {
  return smoothstep(0.0, 0.14, heightFraction) * smoothstep(1.0, 0.42, heightFraction);
}

/**
 * Cloud density at a point.
 * `coverage` is supplied by the caller so the light march can reuse the value
 * from the step it started at.
 */
float cloudDensity(vec3 p, float coverage, bool detailed) {
  float layerHeight = uCloudTop - uCloudBottom;
  float heightFraction = saturate((p.y - uCloudBottom) / layerHeight);

  float gradient = heightGradient(heightFraction);
  if (gradient <= 0.0 || coverage <= 0.02) return 0.0;

  vec3 shapeUv = p / SHAPE_PERIOD;
  shapeUv.xz += windOffset(1.0 / SHAPE_PERIOD);
  vec4 shape = texture(uCloudShape, shapeUv);

  // Worley octaves modulate the Perlin-Worley base: this is what carves the
  // billowed, cauliflower silhouette out of an otherwise smooth field.
  float worleyFbm = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
  float base = remap(shape.r, worleyFbm - 1.0, 1.0, 0.0, 1.0);

  float density = saturate(remap(base * gradient, 1.0 - coverage, 1.0, 0.0, 1.0));
  if (density <= 0.0) return 0.0;

  if (detailed) {
    vec3 detailUv = p / DETAIL_PERIOD;
    detailUv.xz += windOffset(1.0 / DETAIL_PERIOD) * 1.8;
    vec3 detail = texture(uCloudDetail, detailUv).rgb;
    float detailFbm = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;

    // Erosion is strongest low in the cloud, which produces the ragged base,
    // and inverts near the top so anvils stay wispy.
    float erosion = mix(detailFbm, 1.0 - detailFbm, saturate(heightFraction * 4.0));
    density = saturate(remap(density, erosion * 0.32, 1.0, 0.0, 1.0));
  }

  return density * uCloudDensity;
}

/** Optical depth toward the sun. */
float lightMarch(vec3 p, vec3 sunDir, float coverage) {
  float layerHeight = uCloudTop - uCloudBottom;
  float stepSize = layerHeight / float(LIGHT_STEPS) * 0.5;
  float opticalDepth = 0.0;
  vec3 pos = p;

  for (int i = 0; i < LIGHT_STEPS; i++) {
    // Cone-spread the samples so the shadow softens with distance — a cheap
    // stand-in for the scattering a single ray cannot represent.
    float spread = float(i) / float(LIGHT_STEPS);
    pos += sunDir * stepSize * (1.0 + spread * 1.4);
    opticalDepth += cloudDensity(pos, coverage, false) * stepSize;
  }
  return opticalDepth;
}

/**
 * Beer-Powder. Plain Beer's law leaves cloud edges too bright because it cannot
 * represent light that scattered in and back out; the powder term darkens
 * exactly those regions.
 */
float beerPowder(float opticalDepth) {
  return 2.0 * exp(-opticalDepth) * (1.0 - exp(-2.0 * opticalDepth));
}

void main() {
  vec3 rayDir = viewRayFromUv(vUv);
  vec3 rayOrigin = uCameraPos.xyz;

  float tBottom = (uCloudBottom - rayOrigin.y) / rayDir.y;
  float tTop = (uCloudTop - rayOrigin.y) / rayDir.y;
  float tStart = min(tBottom, tTop);
  float tEnd = max(tBottom, tTop);

  bool inside = rayOrigin.y > uCloudBottom && rayOrigin.y < uCloudTop;
  if (inside) tStart = 0.0;

  if (tEnd <= 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  tStart = max(tStart, 0.0);

  // Cap the march so a near-horizontal ray does not integrate to the horizon.
  const float MAX_DISTANCE = 24000.0;
  tEnd = min(tEnd, tStart + MAX_DISTANCE);
  if (tEnd <= tStart) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 sunDir = uSunDirection.xyz;
  float cosSun = dot(rayDir, sunDir);
  // Two Henyey-Greenstein lobes: a strong forward one for the silver lining,
  // a weak backward one so the anti-solar side is not black.
  float phase = mix(miePhase(cosSun, 0.78), miePhase(cosSun, -0.32), 0.28) * 4.0 * PI;

  float stepSize = (tEnd - tStart) / float(MARCH_STEPS);
  float dither = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME * 1.618);
  float t = tStart + stepSize * dither;

  vec3 sunRadiance = uSunColor.rgb * uSunDirection.w;
  vec3 ambientTop = skyZenithRadiance() * 1.1;
  vec3 ambientBottom = sampleSkyView(vec3(0.0, 0.12, 0.0)) * 0.42;

  vec3 scattering = vec3(0.0);
  float transmittance = 1.0;

  const float SIGMA_S = 0.055;
  const float SIGMA_E = 0.062;

  for (int i = 0; i < 128; i++) {
    if (i >= MARCH_STEPS) break;
    if (transmittance < 0.012) break;

    vec3 p = rayOrigin + rayDir * t;
    float coverage = cloudCoverage(p.xz);
    float density = cloudDensity(p, coverage, true);

    if (density > 0.001) {
      float lightDepth = lightMarch(p, sunDir, coverage);
      float direct = beerPowder(lightDepth * SIGMA_E * 1.6);

      float heightFraction = saturate((p.y - uCloudBottom) / (uCloudTop - uCloudBottom));
      vec3 ambient = mix(ambientBottom, ambientTop, heightFraction);

      vec3 luminance = sunRadiance * direct * phase + ambient;

      float extinction = density * SIGMA_E;
      float stepTransmittance = exp(-extinction * stepSize);

      // Analytic integration of a constant source over the segment.
      vec3 integrated = (luminance * density * SIGMA_S) *
        (1.0 - stepTransmittance) / max(extinction, 1e-6);

      scattering += transmittance * integrated;
      transmittance *= stepTransmittance;
    }

    t += stepSize;
  }

  // Fade out toward the horizon, where the flat-slab model breaks down and an
  // honest march would need thousands of steps.
  float horizonFade = smoothstep(0.0, 0.09, abs(rayDir.y));
  scattering *= horizonFade;
  transmittance = mix(1.0, transmittance, horizonFade);

  fragColor = vec4(scattering, transmittance);
}

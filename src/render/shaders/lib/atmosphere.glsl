// Physically based sky, after Hillaire 2020 ("A Scalable and Production Ready
// Sky and Atmosphere Rendering Technique").
//
// Three small LUTs replace a per-pixel raymarch:
//   transmittance  (256x64)   how much light survives a path to the sun
//   multiscatter   (32x32)    the second-and-beyond scattering orders
//   sky-view       (192x108)  final radiance per view direction, rebuilt per frame
//
// Together they cost well under a millisecond on an Intel iGPU and give real
// Rayleigh/Mie behaviour: the sky reddens at sunset because short wavelengths
// have actually been scattered out along a longer path, not because a gradient
// was keyed to time of day.

#ifndef LIB_ATMOSPHERE
#define LIB_ATMOSPHERE

#include "lib/common.glsl"

// Earth-like parameters, in kilometres and km^-1.
const float GROUND_RADIUS = 6360.0;
const float ATMOSPHERE_RADIUS = 6460.0;

const vec3 RAYLEIGH_SCATTERING = vec3(5.802, 13.558, 33.100) * 1e-3;
const float RAYLEIGH_HEIGHT = 8.0;

const float MIE_SCATTERING = 3.996e-3;
const float MIE_ABSORPTION = 4.400e-3;
const float MIE_HEIGHT = 1.2;

// Ozone sits in a band around 25 km and is what keeps the zenith blue at dusk
// after Rayleigh scattering alone would have gone grey.
const vec3 OZONE_ABSORPTION = vec3(0.650, 1.881, 0.085) * 1e-3;
const float OZONE_CENTER = 25.0;
const float OZONE_WIDTH = 15.0;

const float TRANSMITTANCE_LUT_WIDTH = 256.0;
const float TRANSMITTANCE_LUT_HEIGHT = 64.0;
const float MULTISCATTER_LUT_SIZE = 32.0;
const float SKYVIEW_LUT_WIDTH = 192.0;
const float SKYVIEW_LUT_HEIGHT = 108.0;

/** Scattering and extinction coefficients at a given altitude. */
void sampleMedium(
  float altitude,
  out vec3 rayleighScattering,
  out float mieScattering,
  out vec3 extinction
) {
  float rayleighDensity = exp(-altitude / RAYLEIGH_HEIGHT);
  float mieDensity = exp(-altitude / MIE_HEIGHT);
  // Tent profile for the ozone layer.
  float ozoneDensity = max(0.0, 1.0 - abs(altitude - OZONE_CENTER) / OZONE_WIDTH);

  rayleighScattering = RAYLEIGH_SCATTERING * rayleighDensity;
  mieScattering = MIE_SCATTERING * mieDensity;

  extinction =
    rayleighScattering +
    vec3(mieScattering + MIE_ABSORPTION * mieDensity) +
    OZONE_ABSORPTION * ozoneDensity;
}

float rayleighPhase(float cosTheta) {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

/** Cornette-Shanks approximation of the Mie phase function. */
float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta)) /
    ((2.0 + g2) * pow(max(denom, 1e-4), 1.5));
}

// ---------------------------------------------------------------------------
// Transmittance LUT
// ---------------------------------------------------------------------------

/** LUT uv <-> (altitude, cos of sun zenith angle). */
vec2 transmittanceParamsToUv(float radius, float cosZenith) {
  float H = sqrt(max(0.0, ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS - GROUND_RADIUS * GROUND_RADIUS));
  float rho = sqrt(max(0.0, radius * radius - GROUND_RADIUS * GROUND_RADIUS));

  float discriminant = radius * radius * (cosZenith * cosZenith - 1.0) +
    ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS;
  float d = max(0.0, -radius * cosZenith + sqrt(max(discriminant, 0.0)));

  float dMin = ATMOSPHERE_RADIUS - radius;
  float dMax = rho + H;
  float u = (d - dMin) / max(dMax - dMin, 1e-6);
  float v = rho / max(H, 1e-6);
  return vec2(u, v);
}

void uvToTransmittanceParams(vec2 uv, out float radius, out float cosZenith) {
  float H = sqrt(max(0.0, ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS - GROUND_RADIUS * GROUND_RADIUS));
  float rho = H * uv.y;
  radius = sqrt(rho * rho + GROUND_RADIUS * GROUND_RADIUS);

  float dMin = ATMOSPHERE_RADIUS - radius;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  cosZenith = d == 0.0 ? 1.0 :
    (H * H - rho * rho - d * d) / (2.0 * radius * d);
  cosZenith = clamp(cosZenith, -1.0, 1.0);
}

/** Distance from a point at `radius` looking at `cosZenith` to the atmosphere top. */
float distanceToAtmosphereTop(float radius, float cosZenith) {
  float discriminant = radius * radius * (cosZenith * cosZenith - 1.0) +
    ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS;
  return max(0.0, -radius * cosZenith + sqrt(max(discriminant, 0.0)));
}

bool intersectsGround(float radius, float cosZenith) {
  return cosZenith < 0.0 &&
    (radius * radius * (cosZenith * cosZenith - 1.0) + GROUND_RADIUS * GROUND_RADIUS) >= 0.0;
}

/** Integrates optical depth from a point to the top of the atmosphere. */
vec3 computeTransmittance(float radius, float cosZenith, int steps) {
  float t = distanceToAtmosphereTop(radius, cosZenith);
  float dt = t / float(steps);
  vec3 opticalDepth = vec3(0.0);

  for (int i = 0; i < steps; i++) {
    float d = (float(i) + 0.5) * dt;
    // Law of cosines gives the altitude at distance d along the ray.
    float r = sqrt(d * d + 2.0 * radius * cosZenith * d + radius * radius);
    vec3 rayleigh;
    float mie;
    vec3 extinction;
    sampleMedium(r - GROUND_RADIUS, rayleigh, mie, extinction);
    opticalDepth += extinction * dt;
  }
  return exp(-opticalDepth);
}

vec3 sampleTransmittance(sampler2D lut, float radius, float cosZenith) {
  vec2 uv = transmittanceParamsToUv(radius, cosZenith);
  return texture(lut, uv).rgb;
}

// ---------------------------------------------------------------------------
// Sky-view LUT parameterisation
//
// The vertical axis is warped so that half the texels sit in the few degrees
// around the horizon, where the gradient is steepest. Without this the horizon
// bands badly at 108 rows.
// ---------------------------------------------------------------------------

/**
 * `horizonAngles` is (zenithHorizonAngle, beta) for the camera's altitude.
 * Both depend only on the radius, so the caller passes them in as a frame
 * constant rather than paying an acos per fragment.
 */
vec2 skyViewParamsToUv(
  bool groundIntersect, float cosView, float cosLight, vec2 horizonAngles
) {
  float zenithHorizonAngle = horizonAngles.x;
  float beta = horizonAngles.y;
  float viewZenithAngle = acos(clamp(cosView, -1.0, 1.0));

  float v;
  if (!groundIntersect) {
    float coord = viewZenithAngle / zenithHorizonAngle;
    coord = 1.0 - sqrt(max(0.0, 1.0 - coord));
    v = coord * 0.5;
  } else {
    float coord = (viewZenithAngle - zenithHorizonAngle) / beta;
    v = sqrt(max(0.0, coord)) * 0.5 + 0.5;
  }

  float u = sqrt(max(0.0, (-cosLight * 0.5 + 0.5)));
  return vec2(
    fromUnitToSubUv(u, SKYVIEW_LUT_WIDTH),
    fromUnitToSubUv(v, SKYVIEW_LUT_HEIGHT)
  );
}

void uvToSkyViewParams(vec2 uv, float radius, out float cosView, out float cosLight) {
  uv = vec2(
    fromSubUvToUnit(uv.x, SKYVIEW_LUT_WIDTH),
    fromSubUvToUnit(uv.y, SKYVIEW_LUT_HEIGHT)
  );

  float horizonDistance = sqrt(max(0.0, radius * radius - GROUND_RADIUS * GROUND_RADIUS));
  float cosBeta = horizonDistance / radius;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizonAngle = PI - beta;

  if (uv.y < 0.5) {
    float coord = 1.0 - 2.0 * uv.y;
    coord = 1.0 - coord * coord;
    cosView = cos(zenithHorizonAngle * coord);
  } else {
    float coord = uv.y * 2.0 - 1.0;
    cosView = cos(zenithHorizonAngle + beta * coord * coord);
  }

  float coord = uv.x * uv.x;
  cosLight = -(coord * 2.0 - 1.0);
}

// ---------------------------------------------------------------------------
// Raymarched scattering
// ---------------------------------------------------------------------------

struct ScatteringResult {
  vec3 luminance;
  /** Ratio used only when building the multiple-scattering LUT. */
  vec3 multiScatterAs1;
};

/**
 * Single-scattering integration along a view ray, with the multiple-scattering
 * LUT folded in as an isotropic ambient term.
 */
ScatteringResult integrateScattering(
  vec3 worldPos,
  vec3 worldDir,
  vec3 sunDir,
  sampler2D transmittanceLut,
  sampler2D multiScatterLut,
  int steps,
  bool includeMultiScatter,
  float mieAnisotropy
) {
  ScatteringResult result;
  result.luminance = vec3(0.0);
  result.multiScatterAs1 = vec3(0.0);

  float radius = length(worldPos);
  float cosView = dot(worldPos, worldDir) / radius;

  float tMax = distanceToAtmosphereTop(radius, cosView);
  if (intersectsGround(radius, cosView)) {
    // Stop at the planet surface.
    float disc = radius * radius * (cosView * cosView - 1.0) + GROUND_RADIUS * GROUND_RADIUS;
    tMax = max(0.0, -radius * cosView - sqrt(max(disc, 0.0)));
  }
  if (tMax <= 0.0) return result;

  float cosSun = dot(worldDir, sunDir);
  float phaseR = rayleighPhase(cosSun);
  float phaseM = miePhase(cosSun, mieAnisotropy);

  vec3 throughput = vec3(1.0);
  float dt = tMax / float(steps);

  for (int i = 0; i < steps; i++) {
    float t = (float(i) + 0.3) * dt;
    vec3 p = worldPos + worldDir * t;
    float r = length(p);
    float altitude = r - GROUND_RADIUS;

    vec3 rayleigh;
    float mie;
    vec3 extinction;
    sampleMedium(altitude, rayleigh, mie, extinction);

    vec3 sampleTransmit = exp(-extinction * dt);

    float cosSunZenith = dot(p, sunDir) / r;
    vec3 sunTransmit = sampleTransmittance(transmittanceLut, r, cosSunZenith);
    // Shadowed by the planet itself.
    float earthShadow = intersectsGround(r, cosSunZenith) ? 0.0 : 1.0;

    vec3 scatteringNoPhase = rayleigh + vec3(mie);
    vec3 scatteringWithPhase = rayleigh * phaseR + vec3(mie * phaseM);

    vec3 multiScatter = vec3(0.0);
    if (includeMultiScatter) {
      vec2 uv = vec2(
        saturate(cosSunZenith * 0.5 + 0.5),
        saturate((r - GROUND_RADIUS) / (ATMOSPHERE_RADIUS - GROUND_RADIUS))
      );
      uv = vec2(
        fromUnitToSubUv(uv.x, MULTISCATTER_LUT_SIZE),
        fromUnitToSubUv(uv.y, MULTISCATTER_LUT_SIZE)
      );
      multiScatter = texture(multiScatterLut, uv).rgb;
    }

    vec3 inScatter =
      scatteringWithPhase * sunTransmit * earthShadow +
      scatteringNoPhase * multiScatter;

    // Energy-conserving analytic integration of the segment (Hillaire eq. 6):
    // integrating the constant source term against the exponential falloff is
    // what allows 24 steps to look like 128.
    vec3 safeExtinction = max(extinction, vec3(1e-7));
    vec3 integrated = (inScatter - inScatter * sampleTransmit) / safeExtinction;
    result.luminance += throughput * integrated;

    vec3 msIntegrated = (scatteringNoPhase - scatteringNoPhase * sampleTransmit) / safeExtinction;
    result.multiScatterAs1 += throughput * msIntegrated;

    throughput *= sampleTransmit;
  }

  return result;
}

#endif

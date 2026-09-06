// Reading the atmosphere LUTs from a shading pass, plus the aerial-perspective
// fog built on top of them.
//
// The fog colour is the *actual* sky radiance in the view direction, taken from
// the sky-view LUT. That single choice is what makes distant terrain sit inside
// the scene: at sunset the haze in front of the sun goes orange and the haze
// behind the camera stays blue, with no artist-authored gradient anywhere.

#ifndef LIB_SKY_SAMPLE
#define LIB_SKY_SAMPLE

#include "lib/common.glsl"
#include "lib/atmosphere.glsl"
#include "lib/scene.glsl"

uniform sampler2D uSkyViewLut;
uniform sampler2D uTransmittanceLut;

/** Camera altitude in kilometres above the atmosphere's ground shell. */
uniform float uCameraRadiusKm;
/**
 * (zenith-to-horizon angle, horizon-to-nadir angle) for the camera's altitude.
 *
 * Both derive from the camera radius alone, so they are constant for the whole
 * frame. Computing them per fragment cost an acos and a division inside a
 * function called two or three times per pixel.
 */
uniform vec2 uHorizonAngles;
/** Sea level in world blocks, so altitude can be derived per fragment. */
uniform float uSeaLevel;

/** Radiance of the sky in a direction, from the per-frame sky-view LUT. */
vec3 sampleSkyView(vec3 dir) {
  // The LUT is built in a frame whose "up" is +Y, matching world space.
  float cosView = dir.y;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 sunDir = uSunDirection.xyz;

  // Azimuth is measured against the sun's projection onto the horizon plane.
  vec3 sunHorizon = normalize(sunDir - up * dot(sunDir, up));
  vec3 viewHorizon = dir - up * dot(dir, up);
  float horizonLength = length(viewHorizon);
  float cosLight = horizonLength > 1e-5
    ? dot(normalize(viewHorizon), sunHorizon)
    : 1.0;

  bool groundHit = intersectsGround(uCameraRadiusKm, cosView);
  vec2 uv = skyViewParamsToUv(groundHit, cosView, cosLight, uHorizonAngles);
  return texture(uSkyViewLut, uv).rgb;
}

/**
 * Atmosphere radiance in any direction, including below the horizon.
 *
 * The sky-view LUT only describes directions that see sky. Looking down, both
 * the fog and the sky dome need *something*, and they must agree — when they
 * disagreed the result was a hard grey band sitting above the water at the
 * horizon. Clamping the direction to the horizon and dimming it gives a single
 * answer both callers can use.
 */
vec3 atmosphereColor(vec3 dir) {
  vec3 clamped = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z));
  vec3 color = sampleSkyView(clamped);
  if (dir.y < 0.0) {
    // Distant land seen through a lot of haze: dimmer and less saturated than
    // the sky it sits under, but the same hue.
    float below = saturate(-dir.y * 5.0);
    color *= mix(1.0, 0.58, below);
    color = mix(color, vec3(luminance(color)), below * 0.3);
  }
  return color;
}

/**
 * Sky radiance straight up, as a single texture fetch.
 *
 * `sampleSkyView` costs a normalize, two dot products, an acos and a division
 * to build its uv. For the zenith that uv is a constant — the LUT's vertical
 * parameterisation puts the zenith at v = 0 — so any caller that wants "the
 * sky overhead" should use this instead. It is the ambient term for water,
 * clouds and weather, so it runs on a large share of the frame's pixels.
 */
vec3 skyZenithRadiance() {
  return texture(uSkyViewLut, vec2(0.5, 0.004)).rgb;
}

/** Sun colour after atmospheric extinction along the path to the camera. */
vec3 sunTransmittance() {
  return sampleTransmittance(uTransmittanceLut, uCameraRadiusKm, uSunDirection.y);
}

/**
 * Sun and moon discs, drawn only where nothing else occludes them.
 * The limb-darkening term keeps the disc from reading as a flat sticker.
 */
vec3 celestialBodies(vec3 dir) {
  vec3 result = vec3(0.0);

  const float SUN_COS = 0.99976;  // ~0.53 degrees across
  float sunDot = dot(dir, uSunDirection.xyz);
  if (sunDot > SUN_COS) {
    float t = saturate((sunDot - SUN_COS) / (1.0 - SUN_COS));
    // Physical limb darkening: the edge of the disc is dimmer and redder.
    float limb = pow(max(t, 1e-3), 0.32);
    vec3 tint = mix(vec3(1.0, 0.72, 0.42), vec3(1.0), limb);
    result += uSunColor.rgb * uSunDirection.w * limb * tint * 18.0;
  }

  const float MOON_COS = 0.9995;
  float moonDot = dot(dir, uMoonDirection.xyz);
  if (moonDot > MOON_COS) {
    float t = saturate((moonDot - MOON_COS) / (1.0 - MOON_COS));
    result += uMoonColor.rgb * uMoonDirection.w * sqrt(t) * 1.4;
  }

  return result;
}

/** Faint star field, faded out by daylight and by the moon's glare. */
vec3 starField(vec3 dir, float nightFactor) {
  if (nightFactor <= 0.001) return vec3(0.0);

  vec3 grid = dir * 340.0;
  vec3 cell = floor(grid);
  vec3 local = fract(grid) - 0.5;

  vec3 rnd = hash33(cell);
  if (rnd.x < 0.986) return vec3(0.0);

  vec2 offset = (rnd.yz - 0.5) * 0.55;
  float d = length(local.xy - offset);
  float star = smoothstep(0.09, 0.0, d);

  // Slow twinkle from two out-of-phase sines.
  float twinkle = 0.72 + 0.28 * sin(SCENE_TIME * 2.1 + rnd.y * 40.0) *
    sin(SCENE_TIME * 1.3 + rnd.z * 27.0);

  vec3 colour = mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.86, 0.70), rnd.z);
  return colour * star * twinkle * nightFactor * 1.4;
}

/**
 * Optical depth of exponential height fog along a segment, integrated
 * analytically. Closed form beats marching here: it is exact and costs two
 * exponentials regardless of distance.
 */
float fogOpticalDepth(vec3 origin, vec3 dir, float dist) {
  float density = uFog.x;
  float falloff = uFog.y;
  float relativeY = origin.y - uSeaLevel;

  float dy = dir.y;
  float base = density * exp(-falloff * relativeY);

  if (abs(dy) < 1e-4) return base * dist;
  return base * (1.0 - exp(-falloff * dy * dist)) / (falloff * dy);
}

/**
 * Blends a shaded surface into the atmosphere.
 *
 * `dist` is the distance from the camera to the surface, in blocks.
 */
vec3 applyAerialPerspective(vec3 color, vec3 worldPos, vec3 viewDir, float dist) {
  float start = uFog.z;
  float effective = max(0.0, dist - start);
  if (effective <= 0.0) return color;

  float depth = fogOpticalDepth(uCameraPos.xyz, viewDir, effective);
  float fogAmount = 1.0 - exp(-depth);
  if (fogAmount <= 0.001) return color;

  vec3 fogColor = atmosphereColor(viewDir);

  // Forward-scattered sunlight through the local haze.
  //
  // This term used to be the brightest thing in the frame. It ran a Mie phase
  // at g = 0.76 — which peaks near 2.4 — against the sun's full intensity, so
  // anything seen through haze within twenty degrees of the sun was painted
  // over with something an order of magnitude brighter than the sky, and a
  // wooded hillside on the sunward side of the camera came out as flat white.
  //
  // It was also counting the same photons twice. `fogColor` is the sky-view
  // LUT, and the LUT already integrates single and multiple scattering with
  // its own Mie phase; the sky near the sun is bright in it for exactly this
  // reason. What is genuinely missing is only the near-ground haze the LUT's
  // atmosphere profile does not model, so what is added here is a small local
  // term: a broader lobe, and scaled to sit alongside the sky's brightness
  // rather than the sun's.
  float cosSun = dot(viewDir, uSunDirection.xyz);
  float mie = miePhase(cosSun, 0.60);
  vec3 sunGlow = uSunColor.rgb * uSunDirection.w * mie * 0.05 *
    saturate(uSunDirection.y * 3.0 + 0.2);

  fogColor += sunGlow;

  return mix(color, fogColor, fogAmount);
}

/** Fog amount alone, for passes that need to fade geometry rather than tint it. */
float aerialFogAmount(vec3 viewDir, float dist) {
  float effective = max(0.0, dist - uFog.z);
  return 1.0 - exp(-fogOpticalDepth(uCameraPos.xyz, viewDir, effective));
}

#endif

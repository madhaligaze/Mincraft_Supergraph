// Final composite: bloom, exposure, tone mapping, lens effects, output encode.
//
// This is the only place the image leaves linear HDR. Everything before it —
// sky, terrain, water, clouds — works in physical units, which is what allows
// the sun to be genuinely thousands of times brighter than the shaded side of
// a block without any of it clipping until the tone curve decides where to.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/tonemap.glsl"

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uSceneDepth;
/** 1x1 texture holding the adapted average log luminance. */
uniform sampler2D uAdaptedLuminance;

/** Target middle-grey level the exposure aims for. */
uniform float uExposureKey;
/** Hard limits on the computed exposure multiplier. */
uniform vec2 uExposureLimits;

uniform float uBloomStrength;
uniform float uVignette;
uniform float uChromaticAberration;
uniform float uFilmGrain;
uniform float uContrast;
uniform float uSaturation;
/** Non-zero while the camera is submerged; rgb is the tint. */
uniform vec4 uUnderwater;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 uv = vUv;
  vec2 centered = uv - 0.5;
  float radial = dot(centered, centered);

  vec3 color;

  // Chromatic aberration: sample each channel along a slightly different
  // radial offset. Scaled by r^2 so the centre of the frame stays clean.
  if (uChromaticAberration > 0.0001) {
    vec2 offset = centered * radial * uChromaticAberration * 0.06;
    color.r = texture(uScene, uv + offset).r;
    color.g = texture(uScene, uv).g;
    color.b = texture(uScene, uv - offset).b;
  } else {
    color = texture(uScene, uv).rgb;
  }

  if (uBloomStrength > 0.0001) {
    color = mix(color, texture(uBloom, uv).rgb, uBloomStrength);
  }

  // --- underwater ---
  if (uUnderwater.a > 0.001) {
    float depth = texture(uSceneDepth, uv).r;
    float dist = depth > 0.0 ? linearDepth(depth) : 120.0;
    float absorb = 1.0 - exp(-dist * 0.055);
    color = mix(color, uUnderwater.rgb * (0.14 + 0.5 * uSunDirection.w), absorb * uUnderwater.a);
    // Caustic-ish shimmer over the whole frame.
    float shimmer = sin(uv.x * 42.0 + SCENE_TIME * 1.9) * sin(uv.y * 37.0 - SCENE_TIME * 1.4);
    color *= 1.0 + shimmer * 0.035 * uUnderwater.a;
  }

  // Auto exposure. Without it the scene has to be authored for one time of
  // day: a physically lit noon blows out at the exposure that makes dusk
  // readable, and dusk is black at the exposure that makes noon correct.
  float averageLuminance = exp(texture(uAdaptedLuminance, vec2(0.5)).r);
  float autoExposure = clamp(
    uExposureKey / max(averageLuminance, 1e-4),
    uExposureLimits.x, uExposureLimits.y
  );

  color *= autoExposure * SCENE_EXPOSURE;

  color = filmicContrast(color, uContrast, -2.2);
  color = tonemapACES(color);
  color = adjustSaturation(color, uSaturation);

  if (uVignette > 0.0001) {
    // Natural falloff shape rather than a hard oval.
    float vignette = 1.0 - uVignette * radial * 1.9;
    color *= saturate(vignette);
  }

  color = linearToSrgb(color);

  if (uFilmGrain > 0.0001) {
    // Grain applied after the encode, and scaled down in highlights where real
    // film grain is least visible.
    float grain = hash12(gl_FragCoord.xy + SCENE_FRAME * 17.31) - 0.5;
    color += grain * uFilmGrain * (1.0 - luminance(color) * 0.7);
  }

  // Ordered dither before the 8-bit write; without it a clear dusk sky bands
  // visibly across the gradient.
  float dither = (interleavedGradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  color += dither;

  fragColor = vec4(color, 1.0);
}

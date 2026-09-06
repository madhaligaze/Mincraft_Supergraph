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
/** Non-zero while the camera is submerged; rgb is the water's colour. */
uniform vec4 uUnderwater;
/** How far the camera is below the surface, 0..1 over `SUBMERSION_BLOCKS`. */
uniform float uUnderwaterDepth;

/** Must match SUBMERSION_DEPTH in player/player.ts. */
const float SUBMERSION_BLOCKS = 20.0;

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
  //
  // Everything about being submerged happens in this one pass over the finished
  // frame. That is not a shortcut, it is the only affordable place: the
  // alternative is a variant of every shading program in the engine, and what
  // is being modelled — extinction along the view ray through a uniform
  // medium — is a function of depth and distance, both of which are here.
  //
  // What used to be here was a tint scaled by `0.14 + 0.5 * uSunDirection.w`,
  // and that `w` is the sun's *intensity*, thirteen, not a zero-to-one factor.
  // The tint therefore came out several times brighter than anything it was
  // tinting, which is why being underwater looked like standing in a lit cyan
  // fog rather than being in water. The daylight fraction lives in uSunColor.a.
  if (uUnderwater.a > 0.001) {
    float depth = texture(uSceneDepth, uv).r;
    // Sky pixels are not at infinity down here — they are the surface, a long
    // way off through a medium that will have absorbed everything by then.
    float dist = depth > 0.0 ? linearDepth(depth) : 240.0;

    // Beer-Lambert per channel. Red goes first by a wide margin — a couple of
    // metres of water take most of it — which is why everything under water is
    // blue-green and why a torch down there lights nothing.
    vec3 extinction = vec3(0.34, 0.075, 0.05);

    // Downwelling: the light that reaches anything down here came *down*
    // through the column above the camera and was filtered before it ever hit
    // a surface, so this tints and dims the whole frame regardless of how close
    // the surface is.
    //
    // This is the term that was missing, and its absence is exactly the
    // complaint: with only the view-ray extinction below, the far distance went
    // blue while the sand two metres away stayed sunlit yellow, and the result
    // read as a dry scene with a blue haze rather than as being under water.
    // Depth is in blocks; the factor accounts for the sun coming in at an angle
    // and for scattered light arriving by shorter paths than the vertical.
    float aboveBlocks = uUnderwaterDepth * SUBMERSION_BLOCKS + 1.5;
    vec3 downwelling = exp(-extinction * aboveBlocks * 0.55);
    color *= downwelling;

    // The water's own colour, lit by that same filtered light: what the frame
    // fades to once the view ray is long enough that nothing survives it.
    float daylight = 0.05 + 0.95 * uSunColor.a;
    vec3 medium = uUnderwater.rgb * daylight * downwelling * 0.9;

    vec3 through = exp(-extinction * dist);
    color = color * through + medium * (vec3(1.0) - through);

    // Caustics: light focused by the surface above, so it rides on world
    // position rather than on the screen. Two sheets of noise crossing at an
    // angle and beating against each other is the cheapest thing that reads as
    // caustics, and near the surface in daylight is the only place it shows.
    vec3 worldPos = worldFromDepth(uv, max(depth, 1e-6));
    vec2 c = worldPos.xz * 0.55 + worldPos.y * 0.12;
    float caustic =
      sin(c.x + SCENE_TIME * 1.35) * sin(c.y * 1.17 - SCENE_TIME * 1.05) +
      sin(c.x * 1.63 - SCENE_TIME * 0.9) * sin(c.y * 0.79 + SCENE_TIME * 1.6);
    caustic = saturate(caustic * 0.5 + 0.5);
    float causticFade = (1.0 - uUnderwaterDepth) * uSunColor.a *
      exp(-dist * 0.045);
    color += medium * pow(caustic, 3.0) * causticFade * 1.6;
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

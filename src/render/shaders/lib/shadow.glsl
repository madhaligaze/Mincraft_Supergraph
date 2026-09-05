// Cascaded shadow maps.
//
// Four cascades at most, stored as layers of one depth array texture so the
// whole set costs a single sampler binding. Depth is reversed (near = 1) to
// match the main projection, so the comparison is GEQUAL.

#ifndef LIB_SHADOW
#define LIB_SHADOW

#include "lib/common.glsl"

uniform sampler2DArrayShadow uShadowMap;
uniform mat4 uShadowMatrices[4];
/** Far view distance of each cascade. */
uniform vec4 uCascadeSplits;
/** 1 / shadowMapSize. */
uniform float uShadowTexel;
uniform int uCascadeCount;
/** Constant and slope-scaled depth bias, in shadow-map depth units. */
uniform vec2 uShadowBias;

/** Twelve-tap Poisson disc; rotating it per pixel turns banding into noise. */
const vec2 POISSON_12[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696,  0.457),
  vec2(-0.203,  0.621), vec2( 0.962, -0.195), vec2( 0.473, -0.480),
  vec2( 0.519,  0.767), vec2( 0.185, -0.893), vec2( 0.507,  0.064),
  vec2( 0.896,  0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

int selectCascade(float viewDistance) {
  int cascade = uCascadeCount - 1;
  for (int i = 0; i < 4; i++) {
    if (i >= uCascadeCount) break;
    if (viewDistance < uCascadeSplits[i]) {
      cascade = i;
      break;
    }
  }
  return cascade;
}

/**
 * Samples one cascade.
 *
 * `normalOffset` pushes the sample point along the surface normal before
 * projection. This is the cheapest fix for shadow acne on a voxel world: the
 * geometry is all axis-aligned planes, so a normal offset of about one texel of
 * world size removes self-shadowing without the peter-panning a large constant
 * depth bias would cause.
 */
float sampleCascade(
  int cascade, vec3 worldPos, vec3 normal, float NoL, float rotation, int quality
) {
  float texelWorld = uShadowTexel * 2.0 * uCascadeSplits[cascade];
  float slope = clamp(1.0 - NoL, 0.0, 1.0);
  vec3 offsetPos = worldPos + normal * texelWorld * (0.65 + slope * 1.8);

  vec4 shadowClip = uShadowMatrices[cascade] * vec4(offsetPos, 1.0);
  vec3 shadowCoord = shadowClip.xyz / shadowClip.w;
  shadowCoord = shadowCoord * 0.5 + 0.5;

  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0) {
    return 1.0;
  }

  // Reversed depth: a receiver is lit when its depth is greater than the
  // stored occluder depth, so the bias subtracts.
  float bias = uShadowBias.x + uShadowBias.y * slope;
  float reference = shadowCoord.z - bias;

  if (quality <= 1) {
    // Hardware 2x2 PCF from the comparison sampler.
    return texture(uShadowMap, vec4(shadowCoord.xy, float(cascade), reference));
  }

  float s = sin(rotation);
  float c = cos(rotation);
  mat2 rot = mat2(c, -s, s, c);
  float radius = uShadowTexel * (quality >= 3 ? 2.2 : 1.4);

  float sum = 0.0;
  int taps = quality >= 3 ? 12 : 6;
  for (int i = 0; i < 12; i++) {
    if (i >= taps) break;
    vec2 offset = rot * POISSON_12[i] * radius;
    sum += texture(uShadowMap, vec4(shadowCoord.xy + offset, float(cascade), reference));
  }
  return sum / float(taps);
}

/**
 * Full shadow lookup with a cross-fade in the last 12% of each cascade, so the
 * resolution change never appears as a hard line across the ground.
 */
float sampleShadow(
  vec3 worldPos, vec3 normal, float NoL, float viewDistance, float rotation, int quality
) {
  // Quality 0 means shadows are switched off, and the map was never rendered.
  // Sampling it anyway returns whatever was last left in that memory, which
  // shows up as arbitrary dark patches — and made "shadows off" useless as a
  // diagnostic, because the shader was still shadowing.
  if (quality <= 0) return 1.0;

  int cascade = selectCascade(viewDistance);
  float shadow = sampleCascade(cascade, worldPos, normal, NoL, rotation, quality);

  float split = uCascadeSplits[cascade];
  float fadeStart = split * 0.88;
  if (viewDistance > fadeStart && cascade + 1 < uCascadeCount) {
    float blend = saturate((viewDistance - fadeStart) / (split - fadeStart));
    float next = sampleCascade(cascade + 1, worldPos, normal, NoL, rotation, quality);
    shadow = mix(shadow, next, blend);
  }

  // Fade the whole thing out at the far edge rather than popping to lit.
  float far = uCascadeSplits[uCascadeCount - 1];
  shadow = mix(shadow, 1.0, saturate((viewDistance - far * 0.9) / (far * 0.1)));

  return shadow;
}

#endif

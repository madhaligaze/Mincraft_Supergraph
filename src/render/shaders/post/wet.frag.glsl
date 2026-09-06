// Reflections on wet ground.
//
// Rain already darkens and smooths the surfaces it lands on, which gives them
// a sharp reflection of the *sky*. What it could not give them is a reflection
// of what is standing next to them — the wall beside the puddle — because the
// chunk pass runs before there is a frame to reflect. So that part happens
// here instead, after the scene has been drawn and copied, as one screen-space
// pass over the pixels that are actually wet.
//
// Nothing is read back from the target being written: the march samples the
// copy taken a pass earlier, which already holds the terrain, the sky and the
// clouds.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/ssr.glsl"

/** The copy of the scene: colour, with per-pixel wetness left in alpha. */
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform int uSsrSteps;
/** Blocks past which the effect is skipped entirely. */
uniform float uWetDistance;

in vec2 vUv;
out vec4 fragColor;

void main() {
  float depth = texture(uSceneDepth, vUv).r;
  if (depth <= 0.0) discard;                       // sky

  // The chunk shader left its wetness in alpha — it knows things this pass
  // cannot reconstruct, above all whether the surface is under an overhang.
  float wetMask = texture(uSceneColor, vUv).a;
  if (wetMask < 0.02) discard;

  vec3 position = worldFromDepth(vUv, depth);
  vec3 toCamera = uCameraPos.xyz - position;
  float viewDistance = length(toCamera);
  if (viewDistance > uWetDistance) discard;

  // Same trick the ambient occlusion pass uses: the normal comes from the
  // screen-space gradient of the reconstructed position, so no normal buffer
  // has to be written or read.
  vec3 N = normalize(cross(dFdx(position), dFdy(position)));
  if (dot(N, toCamera) < 0.0) N = -N;
  // Water sits on what faces up. A wall stays dry however hard it rains.
  if (N.y < 0.35) discard;

  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 R = reflect(-V, N);

  vec3 hitColor;
  float confidence;
  if (!traceScreenReflection(
    uSceneColor, uSceneDepth, position + N * 0.06, R, uSsrSteps, hitColor, confidence
  )) discard;

  // Fresnel is the whole reason wet ground reads as wet: looking straight down
  // it is barely reflective, at a grazing angle it is a mirror. A constant
  // would look like paint.
  //
  // The curve is deliberately softer than water's own — exponent four, and a
  // floor well above water's 0.02. What is on the ground after rain is not a
  // clean optical surface but a film over rough stone with puddles in the
  // hollows, and at the angle a standing player actually looks at their feet,
  // the physical number is invisible.
  float fresnel = pow(1.0 - saturate(dot(N, V)), 4.0);
  float amount = wetMask * confidence * mix(0.12, 0.92, fresnel) *
    (1.0 - smoothstep(uWetDistance * 0.6, uWetDistance, viewDistance));

  if (amount < 0.004) discard;

  // Alpha blending, so this reads as the surface turning into a mirror rather
  // than as light being added to it.
  fragColor = vec4(hitColor, amount);
}

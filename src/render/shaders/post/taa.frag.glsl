// Temporal antialiasing.
//
// The world is static geometry, so motion vectors do not need a velocity
// buffer: reprojecting the depth buffer through the previous view-projection
// recovers the exact previous screen position of every pixel. That saves an
// RG16F render target and an MRT write in the main pass — real money on a
// bandwidth-limited iGPU.
//
// History is rejected by variance clipping against the 3x3 neighbourhood, which
// is what keeps a disoccluded edge from dragging a ghost behind it.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/tonemap.glsl"

uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uSceneDepth;

/** Base blend factor toward the new frame. */
uniform float uFeedback;

in vec2 vUv;
out vec4 fragColor;

vec3 sampleCurrent(vec2 offset) {
  return tonemapForResolve(texture(uCurrent, vUv + offset * uScreen.zw).rgb);
}

void main() {
  vec3 current = tonemapForResolve(texture(uCurrent, vUv).rgb);

  float depth = texture(uSceneDepth, vUv).r;

  // Reproject. Removing the jitter of both frames is essential: the history was
  // rendered with a different subpixel offset, and comparing the two without
  // undoing it would fight the very sampling TAA relies on.
  vec2 unjitteredUv = vUv - uJitter.xy * 0.5;
  vec3 worldPos = worldFromDepth(unjitteredUv, depth);

  vec4 prevClip = uPrevViewProj * vec4(worldPos, 1.0);
  vec2 prevUv = (prevClip.xy / max(prevClip.w, 1e-6)) * 0.5 + 0.5;
  prevUv -= uJitter.zw * 0.5;

  // Off-screen history has nothing to contribute.
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 || prevClip.w <= 0.0) {
    fragColor = vec4(untonemapForResolve(current), 1.0);
    return;
  }

  vec3 rawHistory = tonemapForResolve(texture(uHistory, prevUv).rgb);
  vec3 history = rawHistory;

  // Neighbourhood statistics for variance clipping.
  vec3 m1 = current;
  vec3 m2 = current * current;
  vec3 minC = current;
  vec3 maxC = current;

  const vec2 OFFSETS[8] = vec2[8](
    vec2(-1.0, -1.0), vec2(0.0, -1.0), vec2(1.0, -1.0),
    vec2(-1.0,  0.0),                  vec2(1.0,  0.0),
    vec2(-1.0,  1.0), vec2(0.0,  1.0), vec2(1.0,  1.0)
  );

  for (int i = 0; i < 8; i++) {
    vec3 c = sampleCurrent(OFFSETS[i]);
    m1 += c;
    m2 += c * c;
    minC = min(minC, c);
    maxC = max(maxC, c);
  }

  vec3 mean = m1 / 9.0;
  vec3 variance = max(m2 / 9.0 - mean * mean, vec3(0.0));
  vec3 sigma = sqrt(variance) * 1.25;

  // Intersecting the AABB with the variance box tightens the clamp on smooth
  // gradients while staying permissive on genuinely high-contrast detail.
  vec3 lo = max(minC, mean - sigma);
  vec3 hi = min(maxC, mean + sigma);
  history = clamp(history, lo, hi);

  // Blend less aggressively where the history was heavily clamped, since that
  // is the signature of a disocclusion.
  float clampAmount = length(history - rawHistory);
  float feedback = mix(uFeedback, 0.85, saturate(clampAmount * 6.0));

  // Reject history that moved a long way this frame — fast camera motion is
  // where ghosting is most visible and where blur is least noticed.
  float motion = length((prevUv - vUv) * uScreen.xy);
  feedback = mix(feedback, 0.92, saturate(motion / 42.0));

  vec3 result = mix(history, current, feedback);
  fragColor = vec4(untonemapForResolve(result), 1.0);
}

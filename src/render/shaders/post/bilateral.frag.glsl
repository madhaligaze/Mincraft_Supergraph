// Separable depth-aware blur for the AO buffer.
//
// A plain Gaussian would smear occlusion across silhouettes; weighting each tap
// by how close its depth is to the centre keeps the darkening attached to the
// surface that generated it.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform sampler2D uSource;
uniform sampler2D uSceneDepth;
/** Texel step: (1/w, 0) horizontally, (0, 1/h) vertically. */
uniform vec2 uDirection;
uniform float uDepthSigma;

in vec2 vUv;
out vec4 fragColor;

const float WEIGHTS[5] = float[5](0.227027, 0.194595, 0.121622, 0.054054, 0.016216);

void main() {
  float centerDepth = texture(uSceneDepth, vUv).r;
  float centerLinear = linearDepth(centerDepth);

  float sum = texture(uSource, vUv).r * WEIGHTS[0];
  float weightSum = WEIGHTS[0];

  for (int i = 1; i < 5; i++) {
    vec2 offset = uDirection * float(i);

    for (int s = 0; s < 2; s++) {
      vec2 uv = s == 0 ? vUv + offset : vUv - offset;
      float sampleDepth = texture(uSceneDepth, uv).r;
      if (sampleDepth <= 0.0) continue;

      float depthDelta = abs(linearDepth(sampleDepth) - centerLinear);
      float depthWeight = exp(-depthDelta * depthDelta / (2.0 * uDepthSigma * uDepthSigma));
      float w = WEIGHTS[i] * depthWeight;

      sum += texture(uSource, uv).r * w;
      weightSum += w;
    }
  }

  fragColor = vec4(sum / max(weightSum, 1e-4), 0.0, 0.0, 1.0);
}

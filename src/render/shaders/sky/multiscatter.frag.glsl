// Multiple-scattering LUT.
//
// Single scattering alone leaves the sky far too dark near the horizon and
// turns the shadowed side of clouds black. Rather than tracing higher orders,
// Hillaire's method assumes light scatters isotropically after the first bounce
// and sums the resulting geometric series in closed form — one texture lookup
// then stands in for every order beyond the first.
//
// Computed once at startup; it depends only on altitude and sun elevation.

#include "lib/atmosphere.glsl"

uniform sampler2D uTransmittanceLut;

in vec2 vUv;
out vec4 fragColor;

/** Directions sampled over the sphere per axis; total is the square of this. */
const int SQRT_SAMPLES = 6;
const int MARCH_STEPS = 16;

void main() {
  vec2 uv = vec2(
    fromSubUvToUnit(vUv.x, MULTISCATTER_LUT_SIZE),
    fromSubUvToUnit(vUv.y, MULTISCATTER_LUT_SIZE)
  );

  float cosSunZenith = uv.x * 2.0 - 1.0;
  vec3 sunDir = vec3(0.0, cosSunZenith, sqrt(saturate(1.0 - cosSunZenith * cosSunZenith)));
  float radius = mix(
    GROUND_RADIUS + 0.001,
    ATMOSPHERE_RADIUS,
    uv.y
  );

  vec3 worldPos = vec3(0.0, radius, 0.0);

  // Rotate so that "up" at the sample point is +Y, matching the LUT's frame.
  vec3 luminanceSum = vec3(0.0);
  vec3 multiScatterSum = vec3(0.0);

  const float invSamples = 1.0 / float(SQRT_SAMPLES * SQRT_SAMPLES);

  for (int i = 0; i < SQRT_SAMPLES; i++) {
    for (int j = 0; j < SQRT_SAMPLES; j++) {
      // Uniform sphere sampling: theta from acos so solid angle is even.
      float u = (float(i) + 0.5) / float(SQRT_SAMPLES);
      float v = (float(j) + 0.5) / float(SQRT_SAMPLES);
      float theta = 2.0 * PI * u;
      float phi = acos(1.0 - 2.0 * v);
      float sinPhi = sin(phi);

      vec3 dir = vec3(sinPhi * cos(theta), cos(phi), sinPhi * sin(theta));

      // Integrate with an isotropic phase (1/4pi) because the second and later
      // orders have lost their directional memory.
      ScatteringResult result = integrateScattering(
        worldPos, dir, sunDir,
        uTransmittanceLut, uTransmittanceLut,
        MARCH_STEPS, false, 0.0
      );

      luminanceSum += result.luminance * invSamples;
      multiScatterSum += result.multiScatterAs1 * invSamples;
    }
  }

  // Geometric series: total = L2 * 1/(1 - f), with f the fraction that scatters
  // again on each subsequent bounce.
  vec3 r = multiScatterSum;
  vec3 sumOfAllOrders = vec3(1.0) / (vec3(1.0) - r);
  fragColor = vec4(luminanceSum * sumOfAllOrders, 1.0);
}

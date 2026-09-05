// Transmittance LUT: how much of the sun's light survives the path from a
// point in the atmosphere to space. Computed once at startup.

#include "lib/atmosphere.glsl"

in vec2 vUv;
out vec4 fragColor;

void main() {
  float radius;
  float cosZenith;
  uvToTransmittanceParams(vUv, radius, cosZenith);
  fragColor = vec4(computeTransmittance(radius, cosZenith, 40), 1.0);
}

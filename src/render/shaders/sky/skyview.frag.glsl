// Sky-view LUT: the finished sky radiance for every view direction, rebuilt
// each frame at 192x108.
//
// Everything downstream — the sky dome, the fog colour, the ambient term on
// every block face, the water reflection fallback — reads this one small
// texture, so the expensive scattering integral runs about twenty thousand
// times per frame instead of once per pixel.

#include "lib/atmosphere.glsl"
#include "lib/scene.glsl"

uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatterLut;
uniform float uCameraRadiusKm;

#ifndef MARCH_STEPS
#define MARCH_STEPS 24
#endif

in vec2 vUv;
out vec4 fragColor;

void main() {
  float cosView;
  float cosLight;
  uvToSkyViewParams(vUv, uCameraRadiusKm, cosView, cosLight);

  // Rebuild a view direction in the LUT's canonical frame, where the sun lies
  // in the XY plane and up is +Y.
  float sinView = sqrt(saturate(1.0 - cosView * cosView));
  vec3 viewDir = vec3(
    sinView * sqrt(saturate(1.0 - cosLight * cosLight)),
    cosView,
    sinView * cosLight
  );

  float sunCosZenith = uSunDirection.y;
  vec3 sunDir = vec3(0.0, sunCosZenith, sqrt(saturate(1.0 - sunCosZenith * sunCosZenith)));

  vec3 worldPos = vec3(0.0, uCameraRadiusKm, 0.0);

  ScatteringResult result = integrateScattering(
    worldPos, viewDir, sunDir,
    uTransmittanceLut, uMultiScatterLut,
    MARCH_STEPS, true, 0.8
  );

  vec3 radiance = result.luminance * uSunDirection.w;

  // The moon contributes a dim, blue-shifted second sun. Without it the night
  // sky is flat black and the water has nothing to reflect.
  if (uMoonColor.a > 0.001) {
    float moonCosZenith = uMoonDirection.y;
    vec3 moonDir = vec3(0.0, moonCosZenith, sqrt(saturate(1.0 - moonCosZenith * moonCosZenith)));
    ScatteringResult moonResult = integrateScattering(
      worldPos, viewDir, moonDir,
      uTransmittanceLut, uMultiScatterLut,
      MARCH_STEPS / 2, true, 0.8
    );
    radiance += moonResult.luminance * uMoonDirection.w * uMoonColor.rgb;
  }

  fragColor = vec4(radiance, 1.0);
}

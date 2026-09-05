// Grass blade shading.
//
// Deliberately not the full block BRDF: blades are thin, translucent and mostly
// seen against the sky, so a wrapped diffuse plus a strong transmission term
// reads better and costs a fraction as much. The subsurface glow when the sun
// is behind the blade is the single most recognisable thing about good grass.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/pbr.glsl"
#include "lib/shadow.glsl"
#include "lib/sky_sample.glsl"

#ifndef SHADOW_QUALITY
#define SHADOW_QUALITY 1
#endif

in vec3 vWorldPos;
in vec3 vColor;
in vec2 vBladeUv;
in float vFade;
in float vSkyLight;
flat in vec3 vNormal;

out vec4 fragColor;

void main() {
  if (vFade <= 0.004) discard;

  vec3 toCamera = uCameraPos.xyz - vWorldPos;
  float viewDistance = length(toCamera);
  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 viewDir = -V;

  // Flip the normal toward the viewer: a blade is a single sheet and must be
  // lit as a two-sided surface.
  vec3 N = dot(vNormal, V) < 0.0 ? -vNormal : vNormal;

  vec3 albedo = vColor;
  vec3 color = vec3(0.0);

  float skyTerm = vSkyLight * vSkyLight;

  if (uSunDirection.w > 0.001) {
    float rotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
    float shadow = sampleShadow(
      vWorldPos, N, saturate(dot(N, uSunDirection.xyz)),
      viewDistance, rotation, SHADOW_QUALITY
    );
    shadow *= smoothstep(0.02, 0.35, vSkyLight);

    vec3 sunRadiance = uSunColor.rgb * uSunDirection.w;

    float NoL = dot(N, uSunDirection.xyz);
    color += albedo * INV_PI * wrappedDiffuse(NoL, 0.6) * sunRadiance * shadow;

    // Transmission: light coming through the blade from behind. Sharpened by
    // the view alignment so it only appears when looking toward the sun.
    float transmission = pow(saturate(dot(viewDir, uSunDirection.xyz)), 4.0);
    color += albedo * sunRadiance * shadow * transmission * 0.5 *
      saturate(1.0 - abs(dot(N, uSunDirection.xyz)));

    // A tight specular sheen along the blade, which is what catches a low sun.
    // Tinted toward the blade's own colour rather than left white: an untinted
    // highlight this strong turns a green field yellow under a warm sun.
    vec3 H = normalize(V + uSunDirection.xyz);
    float sheen = pow(saturate(dot(N, H)), 28.0);
    vec3 sheenTint = mix(vec3(1.0), normalize(albedo + 1e-4) * 1.4, 0.55);
    color += sunRadiance * sheenTint * sheen * 0.05 * shadow * vBladeUv.y;
  }

  vec3 skyRadiance = sampleSkyView(normalize(vec3(N.x, max(N.y, 0.2), N.z)));
  color += albedo * skyRadiance * skyTerm * 0.6;
  color += albedo * 0.008;

  color = applyAerialPerspective(color, vWorldPos, viewDir, viewDistance);

  fragColor = vec4(color, vFade);
}

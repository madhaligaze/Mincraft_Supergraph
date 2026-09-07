// Dropped item shading.
//
// A cut-down version of the block shader: sun, sky ambient and baked block
// light, no shadow lookup and no BRDF. An item is a quarter of a block across
// and usually moving, so what it must get right is that it belongs to the same
// scene — the same sky colour, the same aerial perspective — not that its
// specular lobe is correct.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/sky_sample.glsl"

precision highp sampler2DArray;

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vTint;
flat in vec3 vNormal;
flat in float vLayer;
flat in vec2 vLight;

/** Block albedo array; sRGB, so the sample comes back linear. */
uniform sampler2DArray uAlbedoArray;
/** Item icons; drawn on a canvas in sRGB and decoded here. */
uniform sampler2DArray uIconArray;
uniform int uSprite;
uniform int uDebugView;
uniform vec3 uDebugBucket;

/** Matches the block shader, so a torch lights a dropped item the same way. */
const vec3 BLOCK_LIGHT_COLOR = vec3(1.0, 0.58, 0.26);

out vec4 fragColor;

void main() {
  vec4 texel;
  if (uSprite == 1) {
    texel = texture(uIconArray, vec3(vUv, vLayer));
    if (texel.a < 0.4) discard;
    texel.rgb = pow(texel.rgb, vec3(2.2));
  } else {
    texel = texture(uAlbedoArray, vec3(vUv, vLayer));
  }

  if (uDebugView == 8) {
    fragColor = vec4(uDebugBucket, 1.0);
    return;
  }

  vec3 albedo = texel.rgb * vTint;

  vec3 toCamera = uCameraPos.xyz - vWorldPos;
  float viewDistance = length(toCamera);
  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 N = normalize(vNormal);
  // A sprite is a single sheet: light whichever side is being looked at.
  if (uSprite == 1 && dot(N, V) < 0.0) N = -N;

  float skyTerm = vLight.x * vLight.x;
  vec3 color = vec3(0.0);

  if (uSunDirection.w > 0.001) {
    float NoL = saturate(dot(N, uSunDirection.xyz));
    // Wrapped rather than clamped: an item that lands with one face to the sun
    // should not have five black ones.
    float wrapped = saturate((NoL + 0.35) / 1.35);
    color += albedo * INV_PI * wrapped * uSunColor.rgb * uSunDirection.w *
      smoothstep(0.05, 0.5, vLight.x);
  }

  vec3 skyRadiance = sampleSkyView(normalize(vec3(N.x, max(N.y, 0.1), N.z)));
  color += albedo * skyRadiance * skyTerm * 0.75;
  color += albedo * BLOCK_LIGHT_COLOR * vLight.y * vLight.y * 2.6;
  color += albedo * 0.008;

  color = applyAerialPerspective(color, vWorldPos, -V, viewDistance);

  fragColor = vec4(color, 1.0);
}

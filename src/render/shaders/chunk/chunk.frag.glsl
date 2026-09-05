// Main chunk shading.
//
// Forward, single pass, running behind a depth prepass so early-Z rejects
// hidden fragments before any of this executes. Direct sun and moon go through
// a full Cook-Torrance BRDF; the ambient term is the real sky radiance sampled
// from the atmosphere LUT along the surface normal, gated by the baked skylight
// value. That pairing is the whole trick: the sun does contrast and shadows,
// the sky does colour, and a block face in shade picks up the blue of the sky
// above it rather than a flat grey constant.

#include "lib/common.glsl"
#include "lib/scene.glsl"
#include "lib/pbr.glsl"
#include "lib/shadow.glsl"
#include "lib/sky_sample.glsl"

uniform sampler2DArray uAlbedoArray;
uniform sampler2DArray uSurfaceArray;
/** R = height, G = F0, B = subsurface, A = emission. See packLoader.ts. */
uniform sampler2DArray uMaterialArray;
uniform sampler2D uAmbientOcclusion;
/** Material tile resolution, for the manual mip estimate below. */
uniform float uTextureSize;

/**
 * Debug channel selector. 0 shades normally; the rest dump one input as
 * colour, which is the fastest way to find out whether an artefact lives in
 * the mesher's vertex data or in the lighting.
 */
uniform int uDebugView;

/** xyz = world position, w = radius. */
uniform vec4 uPointLightPos[16];
/** rgb = colour, a = intensity. */
uniform vec4 uPointLightColor[16];
uniform int uPointLightCount;

#ifndef SHADOW_QUALITY
#define SHADOW_QUALITY 2
#endif

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vTint;
in vec3 vLightAO;
flat in float vTexLayer;
flat in vec3 vFaceNormal;
flat in vec3 vFaceTangent;

out vec4 fragColor;

/** Warm incandescent colour for torch-like emitters. */
const vec3 BLOCK_LIGHT_COLOR = vec3(1.0, 0.58, 0.26);

void main() {
  vec4 albedoSample = texture(uAlbedoArray, vec3(vUv, vTexLayer));

#ifdef ALPHA_TEST
  // Sharpen the cutout edge against the mip chain: as the mipmap averages
  // alpha down, distant leaves would otherwise dissolve into nothing. GLSL ES
  // 3.00 has no textureQueryLod, so estimate the level from the UV derivatives.
  vec2 texel = vUv * uTextureSize;
  vec2 ddxUv = dFdx(texel);
  vec2 ddyUv = dFdy(texel);
  float lod = max(0.0, 0.5 * log2(max(dot(ddxUv, ddxUv), dot(ddyUv, ddyUv))));
  if (albedoSample.a * (1.0 + lod * 0.4) < 0.5) discard;
#endif

  vec4 surface = texture(uSurfaceArray, vec3(vUv, vTexLayer));
  vec4 matData = texture(uMaterialArray, vec3(vUv, vTexLayer));

  vec3 albedo = albedoSample.rgb * vTint;
  float perceptualRoughness = clamp(surface.b, 0.045, 1.0);
  float textureAO = surface.a;

  // LabPBR encodes reflectance rather than a metal flag. Values at the top of
  // the range mean "metal", where F0 is the albedo itself; everything below is
  // a dielectric whose F0 was measured rather than assumed to be 0.04.
  float f0Encoded = matData.g;
  float metallic = f0Encoded > 0.9 ? 1.0 : 0.0;
  float dielectricF0 = mix(0.02, 0.16, f0Encoded / 0.9);

  // --- normal ---
  vec3 faceNormal = vFaceNormal;
  mat3 tbn = tangentFrame(faceNormal, vFaceTangent);

  vec2 nxy = surface.rg * 2.0 - 1.0;
  vec3 tangentNormal = vec3(nxy, sqrt(saturate(1.0 - dot(nxy, nxy))));
  vec3 N = normalize(tbn * tangentNormal);

  vec3 toCamera = uCameraPos.xyz - vWorldPos;
  float viewDistance = length(toCamera);
  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 viewDir = -V;

  // --- wetness ---
  // Rain pools on upward faces first. Wet surfaces darken (light refracts into
  // the film instead of scattering back) and smooth out (the film fills in the
  // micro-roughness), which is the whole visual signature of a wet world.
  float wetness = SCENE_WETNESS * saturate(faceNormal.y * 0.85 + 0.15) * vLightAO.x;
  albedo *= mix(1.0, 0.62, wetness);
  perceptualRoughness = mix(perceptualRoughness, 0.075, wetness * 0.85);

  float roughness = max(perceptualRoughness * perceptualRoughness, 0.002);

  // --- occlusion ---
#ifdef USE_SSAO
  // The AO buffer was produced at the end of the previous frame, so it has to
  // be sampled where this surface *was* on screen then. Occlusion is attached
  // to world position, which makes the reprojection exact for static geometry.
  vec4 prevClip = uPrevViewProj * vec4(vWorldPos, 1.0);
  vec2 aoUv = (prevClip.xy / max(prevClip.w, 1e-5)) * 0.5 + 0.5;
  float ssao = (prevClip.w > 0.0 && all(equal(clamp(aoUv, 0.0, 1.0), aoUv)))
    ? texture(uAmbientOcclusion, aoUv).r
    : 1.0;
#else
  float ssao = 1.0;
#endif
  // Vertex AO is quantised to four levels; this curve spaces them the way the
  // eye expects rather than linearly.
  float vertexAO = mix(0.28, 1.0, vLightAO.z * vLightAO.z * (3.0 - 2.0 * vLightAO.z));
  float occlusion = vertexAO * textureAO * ssao;

  float skyVisibility = vLightAO.x;

  if (uDebugView > 0) {
    if (uDebugView == 1) fragColor = vec4(vec3(vLightAO.z), 1.0);          // vertex AO
    else if (uDebugView == 2) fragColor = vec4(vec3(skyVisibility), 1.0);  // baked skylight
    else if (uDebugView == 3) fragColor = vec4(vec3(vLightAO.y), 1.0);     // block light
    else if (uDebugView == 4) fragColor = vec4(N * 0.5 + 0.5, 1.0);        // shaded normal
    else if (uDebugView == 5) fragColor = vec4(vec3(ssao), 1.0);           // screen-space AO
    else if (uDebugView == 6) fragColor = vec4(albedoSample.rgb, 1.0);     // raw albedo
    else if (uDebugView == 7) fragColor = vec4(vTint, 1.0);                // biome tint
    else fragColor = vec4(vec3(textureAO), 1.0);                           // texture AO
    return;
  }

  // --- direct sun ---
  vec3 color = vec3(0.0);
  float NoL = dot(N, uSunDirection.xyz);

  if (uSunDirection.w > 0.001) {
    float shadowRotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
    float shadow = sampleShadow(
      vWorldPos, faceNormal, saturate(NoL), viewDistance, shadowRotation, SHADOW_QUALITY
    );

    // Baked skylight vetoes the shadow map: a cave the cascades never covered
    // must not receive direct sun just because nothing occluded it on screen.
    shadow *= smoothstep(0.02, 0.35, skyVisibility);

    vec3 sunRadiance = uSunColor.rgb * uSunDirection.w;

#ifdef FOLIAGE
    // Leaves and blades are thin and translucent; a hard terminator makes a
    // canopy look like painted cardboard.
    float wrapped = wrappedDiffuse(NoL, 0.55);
    vec3 diffuse = albedo * INV_PI * wrapped;
    vec3 specular = directBRDF(albedo, metallic, roughness, N, V, uSunDirection.xyz, dielectricF0) - albedo * INV_PI * saturate(NoL);
    color += (diffuse + max(specular, vec3(0.0))) * sunRadiance * shadow;

    // Light bleeding through from behind. Tinted warm and desaturated: light
    // that has passed through a leaf loses the green the leaf reflects, so
    // reusing the albedo unmodified turns a backlit canopy neon.
    float backlight = saturate(dot(-N, uSunDirection.xyz));
    float transmission = pow(saturate(dot(viewDir, uSunDirection.xyz)), 6.0);
    vec3 transmitTint = mix(albedo, vec3(luminance(albedo)) * vec3(1.15, 1.0, 0.65), 0.45);
    color += transmitTint * sunRadiance * shadow * backlight * transmission * 0.3;
#else
    color += directBRDF(albedo, metallic, roughness, N, V, uSunDirection.xyz, dielectricF0) * sunRadiance * shadow;
#endif
  }

  // --- moon ---
  if (uMoonDirection.w > 0.001) {
    float moonNoL = saturate(dot(N, uMoonDirection.xyz));
    vec3 moonRadiance = uMoonColor.rgb * uMoonDirection.w;
    color += directBRDF(albedo, metallic, roughness, N, V, uMoonDirection.xyz, dielectricF0) *
      moonRadiance * smoothstep(0.02, 0.4, skyVisibility) * moonNoL;
  }

  // --- ambient from the sky ---
  // Bias the sample direction upward so a downward-facing surface still reads
  // the sky rather than the black below the horizon.
  vec3 ambientDir = normalize(vec3(N.x, max(N.y, 0.05), N.z));
  vec3 skyRadiance = sampleSkyView(ambientDir);
  // Ground bounce: sky light that hit the terrain and came back, tinted by it.
  // Derived from the sky sample already taken rather than a second LUT lookup —
  // that lookup costs an acos and a texture fetch, and this runs per pixel.
  vec3 groundRadiance = skyRadiance * vec3(0.34, 0.32, 0.27) * 0.42;

  float skyTerm = skyVisibility * skyVisibility * (3.0 - 2.0 * skyVisibility);
  color += ambientLighting(
    albedo, metallic, perceptualRoughness, N, V,
    skyRadiance * skyTerm, groundRadiance * mix(0.35, 1.0, skyTerm),
    occlusion, dielectricF0
  );

  // A floor so enclosed spaces read as dim rather than as pure black.
  color += albedo * 0.006 * occlusion;

  // --- baked block light ---
  float blockTerm = vLightAO.y * vLightAO.y;
  color += albedo * BLOCK_LIGHT_COLOR * blockTerm * 2.6 * occlusion;

  // --- dynamic point lights ---
  for (int i = 0; i < 16; i++) {
    if (i >= uPointLightCount) break;
    vec3 toLight = uPointLightPos[i].xyz - vWorldPos;
    float distSq = dot(toLight, toLight);
    float radius = uPointLightPos[i].w;
    if (distSq > radius * radius) continue;

    float dist = sqrt(distSq);
    vec3 L = toLight / max(dist, 1e-4);
    // Inverse-square with a windowed cutoff, so a light fades to exactly zero
    // at its radius instead of popping.
    float window = saturate(1.0 - sq(sq(dist / radius)));
    float attenuation = window * window / (distSq + 1.0);

    color += directBRDF(albedo, metallic, roughness, N, V, L, dielectricF0) *
      uPointLightColor[i].rgb * uPointLightColor[i].a * attenuation * occlusion;
  }

  // --- emissive materials ---
  // Emission comes per texel from the material map, so glowing veins in a
  // block light up without the whole block becoming a lamp.
  if (matData.a > 0.004) {
    color += albedoSample.rgb * matData.a * matData.a * 9.0;
  }

  // --- atmosphere ---
  color = applyAerialPerspective(color, vWorldPos, viewDir, viewDistance);

  fragColor = vec4(color, 1.0);
}

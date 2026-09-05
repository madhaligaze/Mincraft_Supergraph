// Physically based shading.
//
// A trimmed Cook-Torrance: GGX distribution, height-correlated Smith
// visibility, Schlick Fresnel, Lambert diffuse. The analytic environment BRDF
// keeps ambient specular free of a lookup texture, which saves both a sampler
// slot and the bandwidth of reading it per pixel.

#ifndef LIB_PBR
#define LIB_PBR

#include "lib/common.glsl"

/** Trowbridge-Reitz (GGX) normal distribution. */
float D_GGX(float NoH, float roughness) {
  float a = NoH * roughness;
  float k = roughness / max(1.0 - NoH * NoH + a * a, 1e-6);
  return k * k * INV_PI;
}

/** Height-correlated Smith visibility, already divided by 4*NoL*NoV. */
float V_SmithGGXCorrelated(float NoV, float NoL, float roughness) {
  float a2 = roughness * roughness;
  float lambdaV = NoL * sqrt(max(NoV * NoV * (1.0 - a2) + a2, 1e-6));
  float lambdaL = NoV * sqrt(max(NoL * NoL * (1.0 - a2) + a2, 1e-6));
  return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

vec3 F_Schlick(vec3 f0, float VoH) {
  float f = pow(1.0 - VoH, 5.0);
  return f0 + (vec3(1.0) - f0) * f;
}

float F_Schlick(float f0, float f90, float VoH) {
  return f0 + (f90 - f0) * pow(1.0 - VoH, 5.0);
}

/**
 * Direct lighting for one light.
 * `roughness` is perceptual roughness squared (i.e. the GGX alpha).
 */
vec3 directBRDF(
  vec3 albedo, float metallic, float roughness,
  vec3 N, vec3 V, vec3 L
) {
  vec3 H = normalize(V + L);
  float NoV = abs(dot(N, V)) + 1e-5;
  float NoL = saturate(dot(N, L));
  float NoH = saturate(dot(N, H));
  float VoH = saturate(dot(V, H));

  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 diffuseColor = albedo * (1.0 - metallic);

  float D = D_GGX(NoH, roughness);
  float Vis = V_SmithGGXCorrelated(NoV, NoL, roughness);
  vec3 F = F_Schlick(f0, VoH);

  vec3 specular = D * Vis * F;
  // Energy left over after the specular lobe took its share.
  vec3 diffuse = diffuseColor * INV_PI * (vec3(1.0) - F);

  return (diffuse + specular) * NoL;
}

/**
 * Karis' analytic fit to the split-sum environment BRDF.
 * Accurate to well under a percent and avoids a 2D LUT fetch per pixel.
 */
vec3 environmentBRDF(vec3 f0, float roughness, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

/**
 * Ambient contribution from a two-lobe sky model: `skyColor` from above,
 * `groundColor` bounced from below, blended by the normal's vertical component.
 * `occlusion` folds together baked skylight, vertex AO and screen-space AO.
 */
vec3 ambientLighting(
  vec3 albedo, float metallic, float perceptualRoughness,
  vec3 N, vec3 V,
  vec3 skyColor, vec3 groundColor,
  float occlusion
) {
  float NoV = saturate(dot(N, V));
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 diffuseColor = albedo * (1.0 - metallic);

  float upness = N.y * 0.5 + 0.5;
  vec3 irradiance = mix(groundColor, skyColor, upness);

  // Specular ambient samples the sky along the reflection vector, flattened
  // toward the normal as roughness grows.
  vec3 R = reflect(-V, N);
  float reflectUpness = saturate(R.y * 0.5 + 0.5);
  vec3 reflectionColor = mix(groundColor, skyColor, mix(reflectUpness, upness, perceptualRoughness));

  vec3 diffuse = diffuseColor * irradiance;
  vec3 specular = reflectionColor * environmentBRDF(f0, perceptualRoughness, NoV);

  // Specular occlusion: a cavity that blocks diffuse must also block the
  // reflection, or crevices develop a bright rim.
  float specularOcclusion = saturate(pow(NoV + occlusion, exp2(-16.0 * perceptualRoughness - 1.0)) - 1.0 + occlusion);

  return diffuse * occlusion + specular * specularOcclusion;
}

/** Wrapped diffuse, for foliage that should not go black on its shadow side. */
float wrappedDiffuse(float NoL, float wrap) {
  return saturate((NoL + wrap) / ((1.0 + wrap) * (1.0 + wrap)));
}

#endif

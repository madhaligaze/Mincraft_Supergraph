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
 * How much of the material's normal map to apply, 0..1.
 *
 * A pack that draws its normals from a rounded-pixel stencil gives every block
 * in the world the same moulded-plastic shading at full strength. See
 * `surfaceDetail` in settings.ts.
 */
uniform float uSurfaceDetail;

#ifdef USE_GI
/**
 * Indirect light: one texel per 4x4x4 blocks, baked in a worker from the world
 * itself (see world/gi.ts). RGB is the colour of the light arriving there as a
 * *fraction of sky radiance*, so one bake works at every hour — the sky colour
 * it gets multiplied by is what changes.
 */
uniform sampler3D uGiVolume;
/** xyz = world-to-grid scale, w = strength (0 before the first bake lands). */
uniform vec4 uGiParams;
#endif

/**
 * Debug channel selector. 0 shades normally; the rest dump one input as
 * colour, which is the fastest way to find out whether an artefact lives in
 * the mesher's vertex data or in the lighting.
 */
uniform int uDebugView;
/** Flat colour for debug view 8: which pass painted this pixel. */
uniform vec3 uDebugBucket;

/** xyz = world position, w = radius. */
uniform vec4 uPointLightPos[16];
/** rgb = colour, a = intensity. */
uniform vec4 uPointLightColor[16];
uniform int uPointLightCount;

#ifndef SHADOW_QUALITY
#define SHADOW_QUALITY 2
#endif

#ifndef POM_STEPS
#define POM_STEPS 12
#endif

#ifndef POM_SHADOW_STEPS
#define POM_SHADOW_STEPS 6
#endif

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vTint;
in vec3 vLightAO;
flat in float vTexLayer;
flat in vec3 vFaceNormal;
/** xyz = texture U axis in world space, w = UV handedness. */
flat in vec4 vFaceTangent;

out vec4 fragColor;

/** Warm incandescent colour for torch-like emitters. */
const vec3 BLOCK_LIGHT_COLOR = vec3(1.0, 0.58, 0.26);

#ifdef USE_POM
/** x = height field depth in blocks, y = 1 / the distance it fades out over. */
uniform vec2 uParallaxParams;

/**
 * Parallax occlusion mapping.
 *
 * The height field is the R channel of the material array — the same channel
 * LabPBR carries and the same one the procedural generator derives its normals
 * from, so every material already has it. 1.0 is the face plane and 0.0 the
 * bottom of the relief, which is why depth is `1 - height` throughout.
 *
 * The march walks the view ray down through the relief in equal depth slices
 * until it passes below the surface, then interpolates between the last two
 * samples for the crossing. Tile UVs are in blocks, so a UV offset and a world
 * offset are the same number and `scale` is simply the relief depth in blocks.
 *
 * Sampling uses an explicit LOD: the loop is non-uniform control flow, where
 * implicit derivatives are undefined, and the height field is smooth enough
 * that one level computed up front costs nothing in quality.
 */
vec2 parallaxUv(
  vec2 uv, vec3 viewTangent, float layer, float lod, float scale, int steps,
  out float hitDepth
) {
  // Total UV travel from the face plane to the bottom of the relief. The
  // clamp on z caps how far a grazing ray can slide sideways; without it the
  // offset runs away at the horizon and smears the material across the face.
  vec2 total = (viewTangent.xy / max(viewTangent.z, 0.3)) * scale;

  float layerStep = 1.0 / float(steps);
  vec2 uvStep = total * layerStep;

  float rayDepth = 0.0;
  float mapDepth = 1.0 - textureLod(uMaterialArray, vec3(uv, layer), lod).r;
  float prevMapDepth = mapDepth;
  vec2 currentUv = uv;

  for (int i = 0; i < POM_STEPS; i++) {
    if (i >= steps || rayDepth >= mapDepth) break;
    prevMapDepth = mapDepth;
    currentUv -= uvStep;
    rayDepth += layerStep;
    mapDepth = 1.0 - textureLod(uMaterialArray, vec3(currentUv, layer), lod).r;
  }

  // Linear crossing between the sample that was still above the relief and the
  // one that went under it.
  float after = mapDepth - rayDepth;
  float before = prevMapDepth - rayDepth + layerStep;
  float weight = saturate(after / (after - before + 1e-5));

  hitDepth = rayDepth - weight * layerStep;
  return mix(currentUv, currentUv + uvStep, weight);
}

#ifdef POM_SHADOW
/**
 * Self-shadowing of the relief.
 *
 * From the point the view ray hit, walk back up towards the sun: if the height
 * field rises above that ray anywhere, this texel sits in the shade of a bump
 * next to it. This is what separates relief that looks modelled from relief
 * that looks drawn on.
 */
float parallaxShadow(
  vec2 uv, vec3 lightTangent, float layer, float lod, float scale, float startDepth
) {
  if (lightTangent.z <= 0.02 || startDepth <= 0.001) return 1.0;

  vec2 uvStep = (lightTangent.xy / lightTangent.z) * scale / float(POM_SHADOW_STEPS);
  float depthStep = startDepth / float(POM_SHADOW_STEPS);

  float occlusion = 0.0;
  vec2 p = uv;
  float rayDepth = startDepth;

  for (int i = 0; i < POM_SHADOW_STEPS; i++) {
    p += uvStep;
    rayDepth -= depthStep;
    float mapDepth = 1.0 - textureLod(uMaterialArray, vec3(p, layer), lod).r;
    // The relief is above the ray here, so it blocks the sun. Weight the
    // nearest blockers highest: a bump right at the sample edge casts the
    // sharpest shadow.
    occlusion = max(occlusion, saturate((rayDepth - mapDepth) * 12.0) *
      (1.0 - float(i) / float(POM_SHADOW_STEPS)));
  }

  return 1.0 - occlusion * 0.85;
}
#endif
#endif

void main() {
  // --- surface basis ---
  // Built from the texture axes rather than an arbitrary tangent so that the
  // normal map and the parallax march agree with the tile layout the mesher
  // wrote, including the two faces where it transposes UV.
  vec3 faceNormal = vFaceNormal;
  vec3 faceTangent = vFaceTangent.xyz;
  vec3 faceBitangent = cross(faceNormal, faceTangent) * vFaceTangent.w;
  mat3 tbn = mat3(faceTangent, faceBitangent, faceNormal);

  vec3 toCamera = uCameraPos.xyz - vWorldPos;
  float viewDistance = length(toCamera);
  vec3 V = toCamera / max(viewDistance, 1e-4);
  vec3 viewDir = -V;

  vec2 uv = vUv;

#if defined(ALPHA_TEST) || defined(USE_POM)
  // GLSL ES 3.00 has no textureQueryLod, so estimate the mip level from the UV
  // derivatives. Taken from the unperturbed UV, which is the one that varies
  // smoothly across the quad.
  vec2 texel = vUv * uTextureSize;
  vec2 ddxUv = dFdx(texel);
  vec2 ddyUv = dFdy(texel);
  float lod = max(0.0, 0.5 * log2(max(dot(ddxUv, ddxUv), dot(ddyUv, ddyUv))));
#endif

  // --- parallax ---
#ifdef USE_POM
  float pomDepth = 0.0;
  vec3 viewTangent = vec3(dot(V, faceTangent), dot(V, faceBitangent), dot(V, faceNormal));

  // Full strength up close, gone well before the fade distance. Fading the
  // relief depth rather than switching the march off keeps the transition
  // invisible; the step count rides the same curve so distant faces pay less.
  float pomFade = saturate((1.0 - viewDistance * uParallaxParams.y) * 2.2);
  if (pomFade > 0.02) {
    // A face seen edge-on needs the most steps: the ray travels far across the
    // relief per unit of depth, and too few slices turn that into stair steps.
    float stepScale = pomFade * mix(1.0, 0.45, saturate(viewTangent.z));
    int steps = int(max(4.0, float(POM_STEPS) * stepScale));
    uv = parallaxUv(
      uv, viewTangent, vTexLayer, lod, uParallaxParams.x * pomFade, steps, pomDepth
    );
  }
#endif

  vec4 albedoSample = texture(uAlbedoArray, vec3(uv, vTexLayer));

#ifdef ALPHA_TEST
  // Sharpen the cutout edge against the mip chain: as the mipmap averages
  // alpha down, distant leaves would otherwise dissolve into nothing.
  if (albedoSample.a * (1.0 + lod * 0.4) < 0.5) discard;
#endif

  vec4 surface = texture(uSurfaceArray, vec3(uv, vTexLayer));
  vec4 matData = texture(uMaterialArray, vec3(uv, vTexLayer));

  vec3 albedo = albedoSample.rgb * vTint;
  float perceptualRoughness = clamp(surface.b, 0.045, 1.0);
  float textureAO = surface.a;

  // LabPBR encodes reflectance rather than a metal flag. Values at the top of
  // the range mean "metal", where F0 is the albedo itself; everything below is
  // a dielectric whose F0 was measured rather than assumed to be 0.04.
  float f0Encoded = matData.g;
  float metallic = f0Encoded > 0.9 ? 1.0 : 0.0;
  float dielectricF0 = mix(0.02, 0.16, f0Encoded / 0.9);

  // One LabPBR channel carries two quantities: the bottom quarter of the range
  // is porosity, everything above it subsurface scattering. Porosity says how
  // much water a material drinks, so sand and stone go dark in the rain while
  // metal and glass only get glossy.
  float porosity = matData.b < 0.255 ? matData.b * 3.92 : 0.0;
  float subsurface = matData.b > 0.255 ? (matData.b - 0.255) * 1.342 : 0.0;

  // --- normal ---
  // The slope is scaled, not the finished vector: halving x and y and
  // rebuilding z is the same as halving the surface gradient, which is what
  // "half as bumpy" actually means. Scaling the normal itself and renormalising
  // would leave the steepest texels almost untouched.
  vec2 nxy = (surface.rg * 2.0 - 1.0) * uSurfaceDetail;
  vec3 tangentNormal = vec3(nxy, sqrt(saturate(1.0 - dot(nxy, nxy))));
  vec3 N = normalize(tbn * tangentNormal);

  // --- indirect light ---
#ifdef USE_GI
  // Sample half a cell out along the normal. A trilinear tap taken on the
  // surface itself straddles the wall it sits on, and the rock inside is black
  // — that is exactly how a light grid leaks darkness onto a lit face.
  vec4 giSample = texture(uGiVolume, (vWorldPos + N * 2.0) * uGiParams.xyz);
  // Alpha carries how open the cell is, and the grid only covers a box around
  // the player: rather than pop at its edge, fade back to the flat
  // approximation over the last few blocks.
  float giTrust = giSample.a * (1.0 - smoothstep(66.0, 88.0, viewDistance)) *
    step(0.0001, uGiParams.w);
#endif

  // --- wetness ---
  // Rain pools on upward faces first. Wet surfaces darken (light refracts into
  // the film instead of scattering back) and smooth out (the film fills in the
  // micro-roughness), which is the whole visual signature of a wet world.
  float wetness = SCENE_WETNESS * saturate(faceNormal.y * 0.85 + 0.15) * vLightAO.x;
  albedo *= mix(1.0, mix(0.62, 0.44, porosity), wetness);
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
    else if (uDebugView == 8) fragColor = vec4(uDebugBucket, 1.0);         // which pass
    else if (uDebugView == 9) fragColor = vec4(vec3(textureAO), 1.0);      // texture AO
#ifdef USE_GI
    // Scaled up: bounced light is a fraction of the sky and would otherwise
    // dump out as near-black.
    else if (uDebugView == 11) fragColor = vec4(giSample.rgb * 5.0, 1.0);  // indirect
    else if (uDebugView == 12) fragColor = vec4(vec3(giTrust), 1.0);       // grid trust
#endif
    // 13 and 14 exist to tell a mesher problem from a shading one: the layer is
    // a flat varying, so a triangle that differs in it came out of the mesher
    // wrong, while a UV discontinuity along a quad diagonal is the shader's.
    else if (uDebugView == 13) fragColor = vec4(fract(uv), 0.0, 1.0);       // uv
    else if (uDebugView == 14) fragColor = vec4(fract(vec3(vTexLayer * 0.077, vTexLayer * 0.31, vTexLayer * 0.13)), 1.0);
    else fragColor = vec4(vec3(matData.r), 1.0);                           // height field
    return;
  }

  // --- direct sun ---
  vec3 color = vec3(0.0);
  float NoL = dot(N, uSunDirection.xyz);

  if (uSunDirection.w > 0.001) {
    // A face turned away from the sun receives no direct light, so the shadow
    // lookup — six filtered taps, and twice that inside a cascade blend band —
    // is pure waste there. In a voxel world roughly half of every visible
    // surface is turned away at any moment.
    //
    // Foliage is the exception: wrapped diffuse and transmission both reach
    // past the terminator, so it needs the lookup a little further round.
#ifdef FOLIAGE
    bool needsShadow = NoL > -0.62;
#else
    bool needsShadow = NoL > 0.0;
#endif

    float shadow = 0.0;
    if (needsShadow) {
      float shadowRotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
      shadow = sampleShadow(
        vWorldPos, faceNormal, saturate(NoL), viewDistance, shadowRotation, SHADOW_QUALITY
      );

      // Baked skylight vetoes the shadow map: a cave the cascades never
      // covered must not receive direct sun just because nothing occluded it
      // on screen.
      shadow *= smoothstep(0.02, 0.35, skyVisibility);

#ifdef POM_SHADOW
      // The cascades resolve metres, not millimetres, so relief can only
      // shadow itself here — inside the texel, from the height field.
      if (pomFade > 0.02 && shadow > 0.0) {
        vec3 lightTangent = vec3(
          dot(uSunDirection.xyz, faceTangent),
          dot(uSunDirection.xyz, faceBitangent),
          dot(uSunDirection.xyz, faceNormal)
        );
        shadow *= parallaxShadow(
          uv, lightTangent, vTexLayer, lod, uParallaxParams.x * pomFade, pomDepth
        );
      }
#endif
    }

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
    //
    // How much gets through is the material's own property, and LabPBR ships
    // it: the subsurface channel is high on leaves and grass and zero on the
    // stone and planks that share this pass.
    float backlight = saturate(dot(-N, uSunDirection.xyz));
    float transmission = pow(saturate(dot(viewDir, uSunDirection.xyz)), 6.0);
    vec3 transmitTint = mix(albedo, vec3(luminance(albedo)) * vec3(1.15, 1.0, 0.65), 0.45);
    color += transmitTint * sunRadiance * shadow * backlight * transmission *
      mix(0.2, 0.55, subsurface);
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

#ifdef USE_GI
  // What the grid holds is a fraction of sky radiance, so multiplying it by
  // the sky of the moment is what makes one bake serve every hour of the day.
  groundRadiance = mix(groundRadiance, skyRadiance * giSample.rgb * uGiParams.w, giTrust);
#endif

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

#ifdef TRANSLUCENT
  // Glass and ice are blended against what is behind them; alpha here is
  // coverage, not a channel to smuggle data through.
  fragColor = vec4(color, albedoSample.a);
#else
  // Alpha carries the wetness into the frame buffer. The screen-space pass
  // that reflects the world in wet ground runs long after this one and cannot
  // work out on its own whether a surface stood under an overhang while it
  // rained — but this shader already knows, because it just used the answer.
  fragColor = vec4(color, wetness);
#endif
}

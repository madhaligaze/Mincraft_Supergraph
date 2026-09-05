// Screen-space ambient occlusion.
//
// Two decisions here are about cost, not quality, and both were driven by
// measurement:
//
//  - Normals are reconstructed from the depth buffer instead of read from a
//    G-buffer. That removed the depth prepass entirely — 7 ms of GPU time and
//    roughly four hundred draw calls, to feed a pass that itself costs 1.5 ms.
//    Faceted normals from screen-space derivatives are more than good enough
//    for an occlusion term.
//
//  - The pass runs at the *end* of a frame and is consumed by the *next* one,
//    reprojected. Occlusion is low frequency and attached to world positions,
//    so a frame of latency is invisible, and it means nothing has to be drawn
//    before shading can begin.
//
// It sits on top of the mesher's per-vertex AO rather than replacing it: the
// baked term handles hard voxel corners exactly, and this adds the contact
// darkening between separate objects that no per-vertex value can know about.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform sampler2D uSceneDepth;

uniform float uRadius;
uniform float uIntensity;
uniform float uBias;

#ifndef SAMPLE_COUNT
#define SAMPLE_COUNT 12
#endif

in vec2 vUv;
out vec4 fragColor;

void main() {
  float depth = texture(uSceneDepth, vUv).r;
  if (depth <= 0.0) {
    // Sky: fully unoccluded.
    fragColor = vec4(1.0);
    return;
  }

  vec3 origin = worldFromDepth(vUv, depth);

  // Reconstruct the surface normal from the screen-space gradient of the
  // reconstructed position. Faceted, but AO never notices.
  vec3 normal = normalize(cross(dFdx(origin), dFdy(origin)));
  vec3 toCamera = uCameraPos.xyz - origin;
  if (dot(normal, toCamera) < 0.0) normal = -normal;

  // Per-pixel rotation turns the fixed sample pattern into noise the blur can
  // resolve, instead of a repeating banding artefact.
  float rotation = interleavedGradientNoise(gl_FragCoord.xy + SCENE_FRAME) * TAU;
  float cs = cos(rotation);
  float sn = sin(rotation);

  // Shrink the radius with distance so the effect stays a contact shadow
  // rather than a huge dark halo across a far hillside.
  float viewDistance = length(toCamera);
  float radius = uRadius * clamp(12.0 / max(viewDistance, 1.0), 0.35, 1.6);

  vec3 tangentHint = abs(normal.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  mat3 basis = tangentFrame(normal, tangentHint);

  float occlusion = 0.0;
  float totalWeight = 0.0;

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    float fi = float(i);
    // Golden-angle spiral: even coverage without storing a kernel.
    float angle = fi * 2.39996323 + rotation;
    float r = sqrt((fi + 0.5) / float(SAMPLE_COUNT));

    vec3 dir = vec3(cos(angle) * r, sin(angle) * r, 0.0);
    dir.z = sqrt(max(0.0, 1.0 - r * r));

    vec3 offsetDir = basis * vec3(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs, dir.z);
    vec3 samplePos = origin + offsetDir * radius * mix(0.25, 1.0, r);

    vec4 clip = uViewProj * vec4(samplePos, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 sampleUv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

    float sampleDepth = texture(uSceneDepth, sampleUv).r;
    if (sampleDepth <= 0.0) continue;

    vec3 scenePos = worldFromDepth(sampleUv, sampleDepth);

    vec3 toSample = scenePos - origin;
    float dist = length(toSample);
    if (dist < 1e-4) continue;

    float NoS = dot(normal, toSample / dist);
    // Range check: something far behind the surface is not an occluder.
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(dist, 1e-3));

    occlusion += saturate(NoS - uBias) * rangeCheck;
    totalWeight += 1.0;
  }

  float ao = totalWeight > 0.0 ? 1.0 - (occlusion / totalWeight) * uIntensity : 1.0;
  fragColor = vec4(saturate(ao), 0.0, 0.0, 1.0);
}

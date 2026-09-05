// Per-frame uniforms, shared by every program through one std140 block.
//
// Binding point 0. The TypeScript side writes this buffer once per frame, so a
// pass switch costs one bind instead of twenty uniform calls — which matters on
// a driver where each GL call carries real validation cost.

#ifndef LIB_SCENE
#define LIB_SCENE

layout(std140) uniform Scene {
  mat4 uViewProj;
  mat4 uPrevViewProj;
  mat4 uInvViewProj;
  mat4 uView;
  mat4 uProj;

  /** xyz = camera world position, w = time in seconds. */
  vec4 uCameraPos;
  /** xyz = direction *toward* the sun, w = intensity. */
  vec4 uSunDirection;
  /** xyz = direction toward the moon, w = intensity. */
  vec4 uMoonDirection;
  /** rgb = sun illuminance after transmittance, a = day factor 0..1. */
  vec4 uSunColor;
  /** rgb = moon illuminance, a = night factor 0..1. */
  vec4 uMoonColor;
  /** width, height, 1/width, 1/height of the render target. */
  vec4 uScreen;
  /** Current TAA jitter xy, previous jitter zw, in NDC. */
  vec4 uJitter;
  /** density, height falloff, start distance, max distance. */
  vec4 uFog;
  /** rain 0..1, surface wetness 0..1, wind strength, wind angle. */
  vec4 uWeather;
  /** exposure, near plane, frame index, delta time. */
  vec4 uMisc;
};

#define SCENE_TIME        uCameraPos.w
#define SCENE_EXPOSURE    uMisc.x
#define SCENE_NEAR        uMisc.y
#define SCENE_FRAME       uMisc.z
#define SCENE_DELTA       uMisc.w
#define SCENE_RAIN        uWeather.x
#define SCENE_WETNESS     uWeather.y
#define SCENE_WIND        uWeather.z
#define SCENE_WIND_ANGLE  uWeather.w

/**
 * Reconstructs a world position from a reversed-Z depth sample.
 * Depth 1 is the near plane and 0 is infinity, so the usual `depth * 2 - 1`
 * remapping still applies — only the ordering changed.
 */
vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  return world.xyz / world.w;
}

/** View-space distance along the forward axis for a reversed-Z depth sample. */
float linearDepth(float depth) {
  // With an infinite reversed-Z projection: z_view = near / depth.
  return depth > 0.0 ? SCENE_NEAR / depth : 1e9;
}

vec3 viewRayFromUv(vec2 uv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  return normalize(world.xyz / world.w - uCameraPos.xyz);
}

#endif

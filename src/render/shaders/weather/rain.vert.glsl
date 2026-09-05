// Rain and snow, generated entirely in the vertex shader.
//
// Particles live in a box that follows the camera. Each instance derives its
// position from its id plus a time offset, wrapped by fract() — so there is no
// simulation state, no buffer to update, and the whole storm costs one
// instanced draw of a two-triangle billboard.

#include "lib/common.glsl"
#include "lib/scene.glsl"

/** Half-extent of the particle box around the camera, in blocks. */
uniform float uRadius;
uniform float uHeight;
uniform float uFallSpeed;
/** 0 = rain streaks, 1 = snowflakes. */
uniform float uSnow;
uniform float uParticleSize;

uniform sampler2DArray uTintAtlas;
uniform vec2 uTintParams;

out vec2 vUv;
out float vFade;

vec4 fetchSurface(vec2 worldXZ) {
  float size = uTintParams.y;
  ivec2 texel = ivec2(mod(floor(worldXZ), vec2(size)));
  return texelFetch(uTintAtlas, ivec3(texel, 3), 0);
}

void main() {
  vec3 seed = hash33(vec3(float(gl_InstanceID) * 0.017, 1.0, 2.0));

  // Cell the particle belongs to, anchored to the camera so the field follows.
  vec2 base = uCameraPos.xz + (seed.xy - 0.5) * 2.0 * uRadius;

  float speed = uFallSpeed * mix(0.85, 1.25, seed.z);
  // fract() gives a sawtooth: the particle falls, then wraps to the top.
  float phase = fract(seed.z + SCENE_TIME * speed / uHeight);
  float y = uCameraPos.y + uHeight * 0.55 - phase * uHeight;

  // Wind pushes the whole field sideways; the offset is derived from the same
  // phase so a particle's path is a straight slanted line.
  vec2 windDir = vec2(cos(SCENE_WIND_ANGLE), sin(SCENE_WIND_ANGLE));
  float drift = phase * uHeight * (0.18 + SCENE_WIND * 0.22);
  vec2 pos = base + windDir * drift;

  if (uSnow > 0.5) {
    // Snow flutters instead of falling straight.
    pos += vec2(
      sin(SCENE_TIME * 1.7 + seed.x * 30.0),
      cos(SCENE_TIME * 1.4 + seed.y * 30.0)
    ) * 0.6;
  }

  // Particles below the terrain surface are indoors or underground; drop them.
  float ground = fetchSurface(pos).r * 255.0;
  bool visible = y > ground && SCENE_RAIN > 0.02;

  if (!visible) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vUv = vec2(0.0);
    vFade = 0.0;
    return;
  }

  vec3 worldPos = vec3(pos.x, y, pos.y);

  // Billboard, but only around the vertical axis: a rain streak must stay
  // vertical on screen or it reads as debris rather than falling water.
  vec3 toCamera = uCameraPos.xyz - worldPos;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));

  int v = gl_VertexID;
  vec2 corner = vec2(float(v & 1), float((v >> 1) & 1));
  vUv = corner;

  float width = uParticleSize * (uSnow > 0.5 ? 1.0 : 0.22);
  float streakLength = uParticleSize * (uSnow > 0.5 ? 1.0 : 6.5);

  vec3 offset =
    right * (corner.x - 0.5) * width +
    vec3(0.0, 1.0, 0.0) * (corner.y - 0.5) * streakLength;

  // Streaks lean with the wind so the motion direction and the shape agree.
  if (uSnow < 0.5) {
    offset.xz += windDir * (corner.y - 0.5) * streakLength * 0.35;
  }

  worldPos += offset;

  float viewDistance = length(uCameraPos.xz - pos);
  vFade = (1.0 - smoothstep(uRadius * 0.55, uRadius, viewDistance)) * SCENE_RAIN;

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}

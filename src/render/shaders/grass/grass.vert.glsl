// GPU-instanced grass blades.
//
// Nothing about this geometry exists on the CPU. Each instance derives its own
// world position from gl_InstanceID over a grid centred on the camera, then
// looks up the terrain height and surface material from the toroidal atlas the
// chunk loader keeps up to date. A cell that is not grass collapses to a
// degenerate triangle and costs one vertex invocation.
//
// That is what makes dense ground cover affordable on an iGPU: no per-frame
// buffer upload, no CPU placement pass, and no draw call per patch.

#include "lib/common.glsl"
#include "lib/scene.glsl"

/** Cells per side of the placement grid. */
uniform int uGridSize;
/** Blades per cell. */
uniform int uBladesPerCell;
/** Radius in blocks at which blades have fully faded out. */
uniform float uGrassDistance;
uniform float uBladeHeight;
uniform float uBladeWidth;

uniform sampler2DArray uTintAtlas;
/** x = 1 / atlas size, y = atlas size. */
uniform vec2 uTintParams;

/** Material id written into atlas layer 3, green channel. */
const float MATERIAL_GRASS = 1.0;

out vec3 vWorldPos;
out vec3 vColor;
out vec2 vBladeUv;
out float vFade;
out float vSkyLight;
flat out vec3 vNormal;

/** Exact texel read of the surface atlas; height must not be interpolated. */
vec4 fetchSurface(vec2 worldXZ) {
  float size = uTintParams.y;
  ivec2 texel = ivec2(mod(floor(worldXZ), vec2(size)));
  return texelFetch(uTintAtlas, ivec3(texel, 3), 0);
}

void main() {
  int cells = uGridSize * uGridSize;
  int cellIndex = gl_InstanceID % cells;
  int bladeIndex = gl_InstanceID / cells;

  int cx = cellIndex % uGridSize;
  int cz = cellIndex / uGridSize;

  // Cells are anchored to integer world coordinates so blades do not swim as
  // the camera moves.
  vec2 origin = floor(uCameraPos.xz) - float(uGridSize) * 0.5;
  vec2 cell = origin + vec2(float(cx), float(cz));

  vec2 rnd = hash22(cell + float(bladeIndex) * 37.13);
  vec2 rnd2 = hash22(cell * 1.37 + float(bladeIndex) * 91.7);
  vec2 pos = cell + rnd;

  vec4 surface = fetchSurface(pos);
  float groundHeight = surface.r * 255.0;
  float material = surface.g * 255.0;
  float skyLight = surface.b;

  float distance = length(pos - uCameraPos.xz);

  // Reject everything that should not grow a blade. Collapsing to a point
  // behind the near plane is the cheapest possible discard.
  bool valid =
    abs(material - MATERIAL_GRASS) < 0.5 &&
    distance < uGrassDistance &&
    // Density thins out with distance instead of stopping at a hard ring.
    rnd2.x < mix(1.0, 0.25, saturate(distance / uGrassDistance));

  if (!valid) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vWorldPos = vec3(0.0);
    vColor = vec3(0.0);
    vBladeUv = vec2(0.0);
    vFade = 0.0;
    vSkyLight = 0.0;
    vNormal = vec3(0.0, 1.0, 0.0);
    return;
  }

  // Blade geometry: a 3-segment tapered strip, 7 vertices.
  int v = gl_VertexID;
  float segment = float(v >> 1) / 3.0;
  float side = v == 6 ? 0.0 : (float(v & 1) * 2.0 - 1.0);

  float heightScale = mix(0.7, 1.35, rnd2.y);
  float height = uBladeHeight * heightScale;
  float width = uBladeWidth * mix(0.8, 1.2, rnd.x) * (1.0 - segment * 0.85);

  // Facing direction, randomised per blade.
  float angle = rnd2.x * TAU;
  vec2 facing = vec2(cos(angle), sin(angle));
  vec2 tangent = vec2(-facing.y, facing.x);

  // Wind: bend increases with the square of the height so the base stays put
  // and the tip travels, which is how a real blade behaves.
  vec2 windDir = vec2(cos(SCENE_WIND_ANGLE), sin(SCENE_WIND_ANGLE));
  float travel = dot(pos, windDir);
  float gust = sin(travel * 0.08 - SCENE_TIME * 0.85) * 0.5 + 0.5;
  float sway = sin(travel * 0.5 - SCENE_TIME * 2.4 + rnd.y * 6.28);
  float bendAmount = SCENE_WIND * (0.25 + gust * 0.75) * (0.35 + sway * 0.65) *
    (1.0 + SCENE_RAIN * 0.6);

  float bend = bendAmount * segment * segment;
  // The blade also curves under its own weight — lightly, or blades read as
  // drooping banana leaves rather than grass.
  float droop = segment * segment * 0.10 * heightScale;

  vec3 local = vec3(
    tangent.x * side * width + windDir.x * bend * height,
    segment * height - droop * height,
    tangent.y * side * width + windDir.y * bend * height
  );

  vec3 worldPos = vec3(pos.x, groundHeight + 1.0, pos.y) + local;

  // Normal points along the blade's facing, tilted back by the bend.
  vNormal = normalize(vec3(facing.x, 0.55, facing.y));

  vWorldPos = worldPos;
  vBladeUv = vec2(side * 0.5 + 0.5, segment);
  vSkyLight = skyLight;

  // Same sRGB decode the chunk shader applies; the atlas stores authored
  // colours, not linear reflectance.
  vec3 encoded = texture(uTintAtlas, vec3(pos * uTintParams.x, 0.0)).rgb;
  vec3 tint = encoded * (encoded * (encoded * 0.305306011 + 0.682171111) + 0.012522878);
  // Darken toward the root: the base of a clump is shadowed by everything
  // above it, and this single gradient does more for the look than any amount
  // of per-blade lighting. Kept well above zero at the base — blades read as
  // black spikes against the ground if the root goes too dark.
  vColor = tint * mix(0.62, 1.25, segment) * mix(0.85, 1.15, rnd2.y);

  vFade = 1.0 - smoothstep(uGrassDistance * 0.65, uGrassDistance, distance);

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}

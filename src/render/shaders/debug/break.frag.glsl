// Breaking cracks.
//
// The reference ships ten hand-drawn stages; this generates them, because a
// crack is a branching line and a branching line is what ridged noise already
// is. Stage is continuous rather than quantised into ten: the progress bar is
// the feedback, and a smoothly filling crack reads it more honestly than a
// ten-step flipbook would.
//
// The pattern is anchored to the face's own UV, so it does not swim when the
// player moves, and it grows outward from the centre — which is where a pick
// lands.

#include "lib/common.glsl"
#include "lib/noise.glsl"

in vec2 vUv;
flat in int vFace;

/** 0..1 through the break. */
uniform float uProgress;

out vec4 fragColor;

void main() {
  if (uProgress <= 0.001) discard;

  // Each face gets its own slice of the noise field, so opposite faces do not
  // mirror each other.
  vec2 p = vUv * 5.0 + vec2(float(vFace) * 17.3, float(vFace) * 9.1);

  // Ridged value noise: the ridge line is where the field crosses its middle.
  float field = fbm2(p, 3);
  float ridge = abs(field - 0.5);

  // Cracks widen and multiply as the block gives way.
  float width = mix(0.008, 0.075, uProgress * uProgress);
  float line = 1.0 - smoothstep(0.0, width, ridge);

  // Growing from the middle outward, with a soft edge, so early progress is a
  // small mark rather than a full web at low opacity.
  float radius = length(vUv - 0.5) * 1.414;
  float reach = smoothstep(uProgress * 1.25, uProgress * 1.25 - 0.35, radius);

  float amount = line * reach;
  if (amount < 0.02) discard;

  // Fine grit inside the crack, so it does not read as a drawn line.
  float grit = fbm2(vUv * 22.0 + float(vFace) * 3.7, 2);
  float shade = mix(0.55, 0.9, grit);

  fragColor = vec4(vec3(0.02, 0.02, 0.025), amount * 0.85 * shade);
}

// Eye adaptation: eases the exposure toward the frame's average luminance.
//
// Renders to a 1x1 target that ping-pongs with the previous frame's value, so
// the whole feedback loop stays on the GPU — no readback, no pipeline stall.
//
// Adaptation is asymmetric on purpose: the eye darkens quickly when it is
// suddenly flooded with light and brightens slowly in the dark, and matching
// that is what makes walking out of a cave feel right instead of feeling like
// a brightness slider being dragged.

#include "lib/common.glsl"
#include "lib/scene.glsl"

uniform sampler2D uCurrent;
uniform sampler2D uPrevious;
uniform vec2 uSpeed;
/** Clamp on the adapted luminance, so a black cave still reads as dark. */
uniform vec2 uRange;
/** 1 on the first frame, to snap instead of easing up from zero. */
uniform float uReset;

out vec4 fragColor;

void main() {
  float current = texture(uCurrent, vec2(0.5)).r;
  float previous = texture(uPrevious, vec2(0.5)).r;

  if (uReset > 0.5) {
    fragColor = vec4(current, 0.0, 0.0, 1.0);
    return;
  }

  float speed = current > previous ? uSpeed.x : uSpeed.y;
  float blend = 1.0 - exp(-SCENE_DELTA * speed);

  float adapted = mix(previous, current, blend);
  adapted = clamp(adapted, log(uRange.x), log(uRange.y));

  fragColor = vec4(adapted, 0.0, 0.0, 1.0);
}

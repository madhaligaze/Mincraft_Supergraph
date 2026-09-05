// Shadow cascade fragment shader: depth only, plus the cutout test so leaves
// cast dappled shade instead of solid cubes.

uniform sampler2DArray uAlbedoArray;

in vec2 vUv;
flat in float vTexLayer;

void main() {
#ifdef ALPHA_TEST
  // No mip correction here on purpose: a shadow caster that thins out with
  // distance would make a canopy's shade flicker as the camera moves.
  if (texture(uAlbedoArray, vec3(vUv, vTexLayer)).a < 0.5) discard;
#endif
}

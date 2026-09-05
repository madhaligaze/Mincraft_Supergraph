// Selection outline colour. Kept dark and semi-transparent so it reads against
// both a bright sky and a dark cave.

uniform vec4 uColor;

out vec4 fragColor;

void main() {
  fragColor = uColor;
}

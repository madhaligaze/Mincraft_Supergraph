/**
 * Checks every face-basis table in the engine with arithmetic.
 *
 * There is one invariant, and it is one line:
 *
 *     u × v == n   for every face
 *
 * When it holds, a quad wound (0,0) → (1,0) → (1,1) is counter-clockwise seen
 * from outside the block, which is what back-face culling expects. When it does
 * not, that face is culled and simply never appears — silently, with no error,
 * no warning and nothing in the profile.
 *
 * This is not hypothetical. Two of the six rows in the dropped-item shader's
 * table were swapped, so every dropped block was drawn as a box with no lid.
 * For months that read as "the item looks flat from above" and was blamed on
 * the camera angle. One cross product would have found it the first day.
 *
 * The tables are parsed out of the source rather than imported, because two of
 * them are GLSL and cannot be imported at all — and because a check that reads
 * the same text the compiler reads cannot drift from it.
 *
 * Usage: node scripts/facecheck.mjs
 */

import { readFileSync } from 'node:fs';

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const show = (v) => `(${v.join(', ')})`;

let failures = 0;

function check(source, faces) {
  console.log(`\n${source}`);
  for (const [i, { n, u, v }] of faces.entries()) {
    const c = cross(u, v);
    const ok = same(c, n);
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ок ' : 'НЕТ'} грань ${i}: u${show(u)} × v${show(v)} = ${show(c)}` +
      `, нормаль ${show(n)}`,
    );
  }
}

/** Pulls `vec3(a, b, c)` triples out of a named GLSL const array. */
function glslTable(text, name) {
  const at = text.indexOf(`${name}[6]`);
  if (at < 0) throw new Error(`не найдена таблица ${name}`);
  const body = text.slice(at, text.indexOf(');', at));
  return [...body.matchAll(/vec3\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

// --- the shared GLSL cube ---
const cube = readFileSync('src/render/shaders/lib/cube.glsl', 'utf8');
const gn = glslTable(cube, 'FACE_N');
const gu = glslTable(cube, 'FACE_U');
const gv = glslTable(cube, 'FACE_V');
check('src/render/shaders/lib/cube.glsl',
  gn.map((n, i) => ({ n, u: gu[i], v: gv[i] })));

// --- the mesher, which has its own and always did ---
const mesher = readFileSync('src/world/mesher.ts', 'utf8');
// From the `= [` that opens the data, not from the declaration: the type above
// it ends in `];` too, and slicing on that cut the table off before it began —
// which made this check quietly pass on zero rows.
const declared = mesher.slice(mesher.indexOf('const FACE_BASIS'));
const basis = declared.slice(declared.indexOf('}> = ['));
const rows = [...basis.slice(0, basis.indexOf('];')).matchAll(
  /n:\s*\[(-?\d+),\s*(-?\d+),\s*(-?\d+)\],\s*u:\s*\[(-?\d+),\s*(-?\d+),\s*(-?\d+)\],\s*v:\s*\[(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/g,
)].map((m) => ({
  n: [+m[1], +m[2], +m[3]],
  u: [+m[4], +m[5], +m[6]],
  v: [+m[7], +m[8], +m[9]],
}));
check('src/world/mesher.ts (FACE_BASIS)', rows);

// --- nobody may keep a private copy of the cube ---
const copies = [
  'src/render/shaders/entity/item.vert.glsl',
  'src/render/shaders/debug/break.vert.glsl',
];
console.log('');
for (const path of copies) {
  const text = readFileSync(path, 'utf8');
  const own = text.includes('FACE_N[6]') || text.includes('FACE_V[6]');
  if (own) {
    failures++;
    console.log(`НЕТ ${path} снова завёл свою таблицу граней вместо lib/cube.glsl`);
  } else {
    console.log(`ок  ${path} пользуется общей таблицей`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`провалено проверок: ${failures}`);
  process.exit(1);
}
console.log('все базисы граней согласованы: u × v = n');

/**
 * Pulls the sound effects the engine uses out of a local Minecraft install.
 *
 * Minecraft stores its assets content-addressed: `assets/indexes/<n>.json` maps
 * a name like `minecraft/sounds/step/grass1.ogg` to a SHA-1, and the file
 * itself lives at `assets/objects/<first two hex chars>/<sha1>` with no
 * extension. This walks that index, copies the groups listed below into
 * `public/sounds/`, and writes a manifest of how many variants each group has.
 *
 * The audio is Mojang's, so `public/sounds/` is in .gitignore exactly like the
 * texture pack: the extractor is part of the project, the content is not. With
 * nothing extracted the engine falls back to synthesised sound.
 *
 * Usage: node scripts/extract-sounds.mjs [minecraftDir] [outDir]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DEFAULT_MC = join(process.env.APPDATA ?? '', '.minecraft');
const mcDir = process.argv[2] ?? DEFAULT_MC;
const outDir = process.argv[3] ?? 'public/sounds';

/**
 * Sound groups to extract, by path prefix under `minecraft/sounds/`.
 *
 * Everything here is either something the player triggers or something the
 * weather does; music and the 776 mob sounds are left behind, which is what
 * keeps this a couple of megabytes instead of 330.
 */
const WANTED = [
  'step/grass', 'step/gravel', 'step/sand', 'step/snow', 'step/stone',
  'step/wood', 'step/wet_grass', 'step/cloth',
  'dig/grass', 'dig/gravel', 'dig/sand', 'dig/snow', 'dig/stone',
  'dig/wood', 'dig/wet_grass', 'dig/cloth',
  'random/glass', 'random/pop', 'random/fizz', 'random/splash', 'random/click',
  'liquid/water', 'liquid/lava', 'liquid/lavapop', 'liquid/splash',
  'ambient/weather/rain', 'ambient/weather/thunder',
  'ambient/cave/cave',
];

if (!existsSync(mcDir)) {
  console.error(`Не найден каталог Minecraft: ${mcDir}`);
  console.error('Передайте путь первым аргументом.');
  process.exit(2);
}

const indexDir = join(mcDir, 'assets', 'indexes');
if (!existsSync(indexDir)) {
  console.error(`Нет ${indexDir} — это не каталог установленной игры.`);
  process.exit(2);
}

// Several index files can coexist (one per asset generation); the newest wins.
const indexFile = readdirSync(indexDir)
  .filter((f) => f.endsWith('.json'))
  .sort((a, b) => statSync(join(indexDir, b)).mtimeMs - statSync(join(indexDir, a)).mtimeMs)[0];

if (!indexFile) {
  console.error(`В ${indexDir} нет ни одного индекса.`);
  process.exit(2);
}

const index = JSON.parse(readFileSync(join(indexDir, indexFile), 'utf8')).objects;
const objectsDir = join(mcDir, 'assets', 'objects');
const PREFIX = 'minecraft/sounds/';

/**
 * Trailing digits are the variant number: `step/grass3.ogg` -> `step/grass`.
 * A group can also be a single file with no number at all (`liquid/lava.ogg`).
 */
const groupOf = (name) => name.replace(/\d*\.ogg$/, '');

const byGroup = new Map();
for (const name of Object.keys(index)) {
  if (!name.startsWith(PREFIX)) continue;
  const relative = name.slice(PREFIX.length);
  const group = groupOf(relative);
  if (!WANTED.includes(group)) continue;
  if (!byGroup.has(group)) byGroup.set(group, []);
  byGroup.get(group).push(relative);
}

mkdirSync(outDir, { recursive: true });

const manifest = {};
let copied = 0;
let bytes = 0;

for (const group of WANTED) {
  const files = (byGroup.get(group) ?? []).sort((a, b) => {
    const na = Number(a.match(/(\d+)\.ogg$/)?.[1] ?? 0);
    const nb = Number(b.match(/(\d+)\.ogg$/)?.[1] ?? 0);
    return na - nb;
  });

  if (files.length === 0) {
    console.log(`нет в паке: ${group}`);
    continue;
  }

  // Variants are renumbered from 1 so the runtime can address them by index
  // without carrying a file list per group.
  files.forEach((relative, i) => {
    const { hash, size } = index[PREFIX + relative];
    const source = join(objectsDir, hash.slice(0, 2), hash);
    if (!existsSync(source)) {
      console.log(`объект отсутствует: ${relative}`);
      return;
    }
    const target = join(outDir, `${group}${i + 1}.ogg`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied++;
    bytes += size;
  });

  manifest[group] = files.length;
}

writeFileSync(
  join(outDir, 'sounds.json'),
  JSON.stringify({
    source: `${mcDir} (индекс ${indexFile})`,
    extracted: new Date().toISOString(),
    groups: manifest,
  }, null, 2),
);

console.log(`\nгрупп ${Object.keys(manifest).length}, файлов ${copied}, ${(bytes / 1048576).toFixed(2)} МБ → ${outDir}`);

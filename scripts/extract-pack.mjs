/**
 * Pulls the materials this engine uses out of a LabPBR resource pack.
 *
 * A pack holds hundreds of blocks; we need forty-four. Extracting only those
 * keeps `public/pack/` at a couple of megabytes instead of twelve, and means
 * the repository never carries the archive itself.
 *
 * The zip is read with a minimal central-directory parser and `zlib`, so there
 * is no dependency to install. Pack entries are stored or deflated — nothing
 * else appears in Minecraft resource packs.
 *
 * Usage: node scripts/extract-pack.mjs ["Pack Name.zip"] [outDir]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const archivePath = process.argv[2] ??
  readdirSync(ROOT).find((f) => f.toLowerCase().endsWith('.zip'));
const outDir = process.argv[3] ?? join(ROOT, 'public', 'pack');

if (!archivePath) {
  console.error('Не найден .zip в корне проекта. Укажите путь аргументом.');
  process.exit(2);
}

const mapping = JSON.parse(readFileSync(join(HERE, 'pack-mapping.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Minimal zip reader
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Returns a Map of entry name -> {offset, method, compressedSize, size}. */
function readZipDirectory(buffer) {
  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so it has to be searched for backwards.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Не найдена запись конца центрального каталога — файл не zip?');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let position = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(position) !== SIG_CENTRAL) {
      throw new Error(`Повреждён центральный каталог на записи ${i}`);
    }
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);

    entries.set(name, { localOffset, method, compressedSize, size });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
    throw new Error('Повреждён локальный заголовок записи');
  }
  // The local header repeats the name and extra fields with its own lengths,
  // which may differ from the central directory's.
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`Неподдерживаемый метод сжатия: ${entry.method}`);
}

// ---------------------------------------------------------------------------

console.log(`архив: ${archivePath}`);
const buffer = readFileSync(join(ROOT, archivePath));
const entries = readZipDirectory(buffer);
console.log(`записей в архиве: ${entries.size}`);

// Pack layouts vary in namespace ("minecraft" vs others), so entries are
// indexed by basename rather than by full path.
const byBasename = new Map();
for (const [name, entry] of entries) {
  if (!name.includes('/textures/block/') || !name.endsWith('.png')) continue;
  byBasename.set(name.slice(name.lastIndexOf('/') + 1), entry);
}
console.log(`текстур блоков: ${byBasename.size}`);

mkdirSync(outDir, { recursive: true });

const SUFFIXES = [
  { suffix: '', label: 'albedo' },
  { suffix: '_n', label: 'normal+AO+height' },
  { suffix: '_s', label: 'smoothness+F0+SSS+emission' },
];

let written = 0;
let bytes = 0;
const missing = [];
const procedural = [];

for (const [ours, theirs] of Object.entries(mapping.textures)) {
  if (theirs === null) {
    procedural.push(ours);
    continue;
  }

  for (const { suffix } of SUFFIXES) {
    const source = `${theirs}${suffix}.png`;
    const entry = byBasename.get(source);
    if (!entry) {
      missing.push(`${ours} -> ${source}`);
      continue;
    }
    const data = readEntry(buffer, entry);
    writeFileSync(join(outDir, `${ours}${suffix}.png`), data);
    written++;
    bytes += data.length;
  }
}

const meta = entries.get('pack.mcmeta');
const description = meta
  ? (JSON.parse(readEntry(buffer, meta).toString('utf8')).pack?.description ?? '')
      .replace(/§./g, '').trim()
  : '';

writeFileSync(
  join(outDir, 'pack.json'),
  JSON.stringify({
    source: archivePath,
    description,
    extracted: new Date().toISOString().slice(0, 10),
    materials: Object.entries(mapping.textures)
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
    procedural,
  }, null, 2),
);

console.log(`\nзаписано файлов: ${written} (${(bytes / 1024 / 1024).toFixed(2)} МБ) -> ${outDir}`);
console.log(`остаются процедурными: ${procedural.join(', ') || '—'}`);
if (missing.length > 0) {
  console.log(`\nНЕ НАЙДЕНО в паке (${missing.length}):`);
  for (const m of missing) console.log(`  ${m}`);
} else {
  console.log('всё, что запрошено, в паке нашлось');
}

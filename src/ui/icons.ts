/**
 * Item icons, drawn once at startup on a canvas.
 *
 * Two consumers, one drawing: the inventory window takes a data URL per item,
 * and the renderer takes the same pixels as a texture array so a stick lying on
 * the ground is the same stick that is in the bag. Drawing them twice — once in
 * CSS and once in GLSL — is how the two drift apart.
 *
 * They are shapes rather than pixel art because the set is small and the
 * difference a player reads at 22 px is silhouette and colour, not detail: a
 * pickaxe is a pickaxe because of its head, and a diamond is a lump that is
 * cyan.
 */

import { ITEMS, type ItemId, type ItemDef } from '../game/items.ts';

export interface IconSet {
  /** Data URL per item id, for `<img>` and CSS. Sparse. */
  urls: string[];
  /** Layer in `pixels` per item id, or -1 for a block (drawn as a real cube). */
  layer: number[];
  /** RGBA texels, `size * size * layers`, for the GPU array texture. */
  pixels: Uint8Array;
  size: number;
  layers: number;
}

const rgb = (c: readonly [number, number, number], scale = 1, alpha = 1): string => {
  const to = (v: number): number => Math.max(0, Math.min(255, Math.round(v * scale * 255)));
  return `rgba(${to(c[0])}, ${to(c[1])}, ${to(c[2])}, ${alpha})`;
};

/** A rounded, slightly irregular lump: coal, a diamond, a piece of raw ore. */
function drawLump(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  const cx = s * 0.5;
  const cy = s * 0.54;
  const r = s * 0.3;
  ctx.beginPath();
  for (let i = 0; i <= 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    // A fixed wobble per vertex, so every lump has facets but they are stable.
    const wobble = 0.82 + 0.18 * Math.abs(Math.sin(i * 2.3 + def.id));
    const x = cx + Math.cos(a) * r * wobble * 1.05;
    const y = cy + Math.sin(a) * r * wobble;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 1);
  ctx.fill();

  // One flat highlight rather than a gradient: it survives being 22 px wide.
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.28, cy - r * 0.34, r * 0.36, r * 0.24, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = rgb(def.color, 1.9, 0.85);
  ctx.fill();

  ctx.lineWidth = Math.max(1, s * 0.04);
  ctx.strokeStyle = rgb(def.color, 0.35, 0.9);
  ctx.stroke();
}

/** An ingot: a flat trapezoid with a bright top face. Reads as "refined". */
function drawIngot(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  const cx = s * 0.5;
  const top = s * 0.42;
  const bottom = s * 0.68;

  ctx.beginPath();
  ctx.moveTo(cx - s * 0.24, top);
  ctx.lineTo(cx + s * 0.24, top);
  ctx.lineTo(cx + s * 0.30, bottom);
  ctx.lineTo(cx - s * 0.30, bottom);
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 0.8);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx - s * 0.20, top - s * 0.10);
  ctx.lineTo(cx + s * 0.20, top - s * 0.10);
  ctx.lineTo(cx + s * 0.24, top);
  ctx.lineTo(cx - s * 0.24, top);
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 1.15);
  ctx.fill();
}

function drawStick(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  ctx.save();
  ctx.translate(s * 0.5, s * 0.5);
  ctx.rotate(-Math.PI / 4);
  const w = s * 0.12;
  const h = s * 0.66;
  ctx.fillStyle = rgb(def.color);
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = rgb(def.color, 1.35);
  ctx.fillRect(-w / 2, -h / 2, w * 0.4, h);
  ctx.restore();
}

/** Handle plus head; `shape` decides only what the head looks like. */
function drawTool(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  const handle = 'rgba(120, 84, 48, 1)';
  const handleLight = 'rgba(150, 108, 64, 1)';

  ctx.save();
  ctx.translate(s * 0.5, s * 0.5);
  ctx.rotate(-Math.PI / 4);

  const w = s * 0.11;
  ctx.fillStyle = handle;
  ctx.fillRect(-w / 2, -s * 0.1, w, s * 0.5);
  ctx.fillStyle = handleLight;
  ctx.fillRect(-w / 2, -s * 0.1, w * 0.4, s * 0.5);

  ctx.fillStyle = rgb(def.color);
  const head = s * 0.34;

  if (def.shape === 'pickaxe') {
    // A shallow arc, thick in the middle: the pickaxe head reads by its curve.
    ctx.beginPath();
    ctx.moveTo(-head, -s * 0.24);
    ctx.quadraticCurveTo(0, -s * 0.42, head, -s * 0.24);
    ctx.quadraticCurveTo(0, -s * 0.28, -head, -s * 0.10);
    ctx.closePath();
    ctx.fill();
  } else if (def.shape === 'shovel') {
    ctx.beginPath();
    ctx.moveTo(-s * 0.17, -s * 0.12);
    ctx.lineTo(s * 0.17, -s * 0.12);
    ctx.lineTo(s * 0.13, -s * 0.36);
    ctx.quadraticCurveTo(0, -s * 0.46, -s * 0.13, -s * 0.36);
    ctx.closePath();
    ctx.fill();
  } else {
    // Axe: a wedge on one side only, which is the whole silhouette.
    ctx.beginPath();
    ctx.moveTo(-s * 0.02, -s * 0.10);
    ctx.lineTo(-s * 0.02, -s * 0.38);
    ctx.quadraticCurveTo(s * 0.30, -s * 0.40, s * 0.26, -s * 0.16);
    ctx.quadraticCurveTo(s * 0.16, -s * 0.06, -s * 0.02, -s * 0.10);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/** A block item: a small isometric cube, so the bag reads like the world. */
function drawBlock(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  const cx = s * 0.5;
  const top = s * 0.16;
  const mid = s * 0.38;
  const bottom = s * 0.84;
  const half = s * 0.34;

  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + half, mid);
  ctx.lineTo(cx, mid + (mid - top));
  ctx.lineTo(cx - half, mid);
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 1.25);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx - half, mid);
  ctx.lineTo(cx, mid + (mid - top));
  ctx.lineTo(cx, bottom);
  ctx.lineTo(cx - half, bottom - (mid - top));
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 0.82);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx + half, mid);
  ctx.lineTo(cx, mid + (mid - top));
  ctx.lineTo(cx, bottom);
  ctx.lineTo(cx + half, bottom - (mid - top));
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 0.58);
  ctx.fill();
}

/**
 * Armour. Four silhouettes, which is all a player reads at slot size — and the
 * slot they belong in is unambiguous from the shape alone.
 */
function drawArmour(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  ctx.fillStyle = rgb(def.color, 0.9);
  ctx.strokeStyle = rgb(def.color, 0.55);
  ctx.lineWidth = Math.max(1, s * 0.045);

  if (def.shape === 'helmet') {
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.52, s * 0.27, Math.PI, 0);
    ctx.lineTo(s * 0.77, s * 0.70);
    ctx.lineTo(s * 0.63, s * 0.70);
    ctx.lineTo(s * 0.63, s * 0.58);
    ctx.lineTo(s * 0.37, s * 0.58);
    ctx.lineTo(s * 0.37, s * 0.70);
    ctx.lineTo(s * 0.23, s * 0.70);
    ctx.closePath();
  } else if (def.shape === 'chestplate') {
    ctx.beginPath();
    ctx.moveTo(s * 0.22, s * 0.28);
    ctx.lineTo(s * 0.38, s * 0.28);
    ctx.lineTo(s * 0.50, s * 0.38);
    ctx.lineTo(s * 0.62, s * 0.28);
    ctx.lineTo(s * 0.78, s * 0.28);
    ctx.lineTo(s * 0.78, s * 0.74);
    ctx.lineTo(s * 0.22, s * 0.74);
    ctx.closePath();
  } else if (def.shape === 'leggings') {
    ctx.beginPath();
    ctx.moveTo(s * 0.26, s * 0.26);
    ctx.lineTo(s * 0.74, s * 0.26);
    ctx.lineTo(s * 0.74, s * 0.78);
    ctx.lineTo(s * 0.58, s * 0.78);
    ctx.lineTo(s * 0.55, s * 0.50);
    ctx.lineTo(s * 0.45, s * 0.50);
    ctx.lineTo(s * 0.42, s * 0.78);
    ctx.lineTo(s * 0.26, s * 0.78);
    ctx.closePath();
  } else {
    // Boots: two of them, side by side.
    ctx.beginPath();
    ctx.moveTo(s * 0.22, s * 0.40);
    ctx.lineTo(s * 0.44, s * 0.40);
    ctx.lineTo(s * 0.44, s * 0.66);
    ctx.lineTo(s * 0.22, s * 0.66);
    ctx.closePath();
    ctx.moveTo(s * 0.56, s * 0.40);
    ctx.lineTo(s * 0.78, s * 0.40);
    ctx.lineTo(s * 0.78, s * 0.66);
    ctx.lineTo(s * 0.56, s * 0.66);
    ctx.closePath();
  }

  ctx.fill();
  ctx.stroke();

  // A highlight along the top, so the metal reads as metal.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = rgb(def.color, 1.35);
  ctx.fillRect(s * 0.26, s * 0.30, s * 0.2, s * 0.04);
  ctx.globalAlpha = 1;
}

/** An apple: a round body, a bite of shading, a stalk and a leaf. */
function drawApple(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.58, s * 0.27, s * 0.26, 0, 0, Math.PI * 2);
  ctx.fillStyle = rgb(def.color);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(s * 0.40, s * 0.50, s * 0.10, s * 0.08, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = rgb(def.color, 1.8, 0.75);
  ctx.fill();

  ctx.strokeStyle = 'rgba(90, 62, 30, 1)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.34);
  ctx.quadraticCurveTo(s * 0.52, s * 0.24, s * 0.48, s * 0.20);
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(s * 0.60, s * 0.26, s * 0.10, s * 0.05, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(70, 130, 50, 1)';
  ctx.fill();
}

/**
 * A bucket: a tapered pail with a handle.
 *
 * The colour carries what is in it — grey empty, blue for water, orange for
 * lava — because at slot size the contents are the only thing that could be
 * read anyway.
 */
function drawBucket(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  ctx.strokeStyle = 'rgba(150, 152, 158, 1)';
  ctx.lineWidth = Math.max(1, s * 0.055);
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.40, s * 0.20, Math.PI, 0);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(s * 0.28, s * 0.38);
  ctx.lineTo(s * 0.72, s * 0.38);
  ctx.lineTo(s * 0.64, s * 0.78);
  ctx.lineTo(s * 0.36, s * 0.78);
  ctx.closePath();
  ctx.fillStyle = rgb(def.color, 0.95);
  ctx.fill();
  ctx.strokeStyle = rgb(def.color, 0.6);
  ctx.stroke();

  // The rim catches the light; without it the pail is a flat trapezoid.
  ctx.fillStyle = rgb(def.color, 1.4);
  ctx.fillRect(s * 0.28, s * 0.36, s * 0.44, s * 0.05);
}

function paint(ctx: CanvasRenderingContext2D, s: number, def: ItemDef): void {
  ctx.clearRect(0, 0, s, s);
  switch (def.shape) {
    case 'block': drawBlock(ctx, s, def); break;
    case 'lump': drawLump(ctx, s, def); break;
    case 'ingot': drawIngot(ctx, s, def); break;
    case 'stick': drawStick(ctx, s, def); break;
    case 'apple': drawApple(ctx, s, def); break;
    case 'bucket': drawBucket(ctx, s, def); break;
    case 'helmet':
    case 'chestplate':
    case 'leggings':
    case 'boots': drawArmour(ctx, s, def); break;
    default: drawTool(ctx, s, def); break;
  }
}

/**
 * Draws every item once.
 *
 * `size` is the icon's pixel size in both outputs; 32 is enough for a 22 px
 * slot on a 2× display and small enough that the whole non-block set is a
 * 32×32×15 array texture — a hundred kilobytes.
 */
export function buildIcons(size = 32): IconSet {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const urls: string[] = [];
  const layer: number[] = new Array(ITEMS.length).fill(-1);

  const sprites: Uint8Array[] = [];

  for (const def of ITEMS) {
    if (!def || def.stack === 0) continue;
    paint(ctx, size, def);
    urls[def.id] = canvas.toDataURL('image/png');

    // Only items that are not blocks need a sprite in the world: a dropped
    // block is drawn as an actual textured cube.
    if (def.shape === 'block') continue;
    layer[def.id] = sprites.length;
    sprites.push(new Uint8Array(ctx.getImageData(0, 0, size, size).data));
  }

  const pixels = new Uint8Array(size * size * 4 * Math.max(1, sprites.length));
  sprites.forEach((sprite, i) => pixels.set(sprite, i * size * size * 4));

  return { urls, layer, pixels, size, layers: Math.max(1, sprites.length) };
}

/** The icon for one item, as a CSS `url(...)` value. */
export function iconUrl(icons: IconSet, id: ItemId): string {
  return icons.urls[id] ?? '';
}

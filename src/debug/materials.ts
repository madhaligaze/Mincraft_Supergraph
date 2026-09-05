/**
 * Material contact sheet.
 *
 * Renders every procedural material at 2x2 tiles so seams, contrast and
 * tileability are all visible at a glance. Iterating on a texture through the
 * game means walking to a block that uses it; this page shows all 46 at once.
 */

import { TEXTURES } from '../world/blocks.ts';
import { bakeMaterial } from '../render/textures.ts';

const SIZE = 128;
const grid = document.getElementById('grid')!;

function draw(canvas: HTMLCanvasElement, data: Uint8Array, tiles: number): void {
  canvas.width = SIZE * tiles;
  canvas.height = SIZE * tiles;
  const ctx = canvas.getContext('2d')!;

  const image = new ImageData(new Uint8ClampedArray(data.slice().buffer), SIZE, SIZE);
  // Draw once into an offscreen canvas, then repeat it — that is what makes a
  // tiling seam obvious rather than something you have to imagine.
  const tile = document.createElement('canvas');
  tile.width = SIZE;
  tile.height = SIZE;
  tile.getContext('2d')!.putImageData(image, 0, 0);

  ctx.imageSmoothingEnabled = false;
  // Flip vertically: the generator's v=0 is the bottom of a block face in the
  // game, but ImageData row 0 is the top of a canvas. Without this the grass
  // fringe and the plant roots appear upside down relative to what you see
  // in-world, which makes the sheet actively misleading.
  ctx.translate(0, canvas.height);
  ctx.scale(1, -1);
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) ctx.drawImage(tile, x * SIZE, y * SIZE);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

for (const name of TEXTURES) {
  const { albedo, surface } = bakeMaterial(name, SIZE);

  const cell = document.createElement('div');
  cell.className = 'cell';

  const albedoCanvas = document.createElement('canvas');
  draw(albedoCanvas, albedo, 2);
  cell.appendChild(albedoCanvas);

  const pair = document.createElement('div');
  pair.className = 'pair';

  // Normal map: RG only, with B forced flat so the shape reads.
  const normalData = new Uint8Array(surface.length);
  const roughData = new Uint8Array(surface.length);
  for (let i = 0; i < surface.length; i += 4) {
    normalData[i] = surface[i];
    normalData[i + 1] = surface[i + 1];
    normalData[i + 2] = 255;
    normalData[i + 3] = 255;
    // Roughness in red, AO in green, so both are visible in one swatch.
    roughData[i] = surface[i + 2];
    roughData[i + 1] = surface[i + 3];
    roughData[i + 2] = surface[i + 2];
    roughData[i + 3] = 255;
  }

  const normalCanvas = document.createElement('canvas');
  draw(normalCanvas, normalData, 1);
  pair.appendChild(normalCanvas);

  const roughCanvas = document.createElement('canvas');
  draw(roughCanvas, roughData, 1);
  pair.appendChild(roughCanvas);

  cell.appendChild(pair);

  const label = document.createElement('span');
  label.textContent = name;
  cell.appendChild(label);

  grid.appendChild(cell);
}

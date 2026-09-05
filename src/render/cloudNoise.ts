/**
 * Baked 3D noise for the cloud renderer.
 *
 * The first implementation evaluated Worley noise analytically in the shader.
 * That is 27 cell lookups per octave, three octaves per sample, and a six-step
 * light march on top — about 500 million hash evaluations per frame, which cost
 * roughly 40 ms on an Intel UHD 620 and was single-handedly the most expensive
 * thing in the renderer.
 *
 * Baking the same functions into two small 3D textures at startup turns each
 * density sample into two texture fetches. This is the standard approach (the
 * shape/detail split comes from Guerrilla's "Nubis" cloud system) and it is the
 * difference between clouds being affordable on integrated graphics and not.
 */

const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;

export interface CloudNoise {
  /** 64^3 RGBA8: R = Perlin-Worley base, GBA = Worley at rising frequencies. */
  shape: WebGLTexture;
  /** 32^3 RGB8: high-frequency Worley used to erode cloud edges. */
  detail: WebGLTexture;
  shapeSize: number;
  detailSize: number;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let n = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ seed;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0xd35a2d97);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}

/**
 * Tileable 3D Worley noise, inverted so 1 is a cell centre.
 * `cells` is the lattice period, which is what makes the result wrap.
 */
function worley3(x: number, y: number, z: number, cells: number, seed: number): number {
  const fx = x * cells;
  const fy = y * cells;
  const fz = z * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);

  let best = 1e9;
  const wrap = (n: number): number => ((n % cells) + cells) % cells;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const wx = wrap(cx), wy = wrap(cy), wz = wrap(cz);
        const px = cx + hash3(wx, wy, wz, seed);
        const py = cy + hash3(wx, wy, wz, seed ^ 0x5bf03635);
        const pz = cz + hash3(wx, wy, wz, seed ^ 0x1b873593);
        const ddx = px - fx, ddy = py - fy, ddz = pz - fz;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

/** Three octaves of Worley, the classic billow stack. */
function worleyFbm(x: number, y: number, z: number, cells: number, seed: number): number {
  return worley3(x, y, z, cells, seed) * 0.625 +
    worley3(x, y, z, cells * 2, seed + 17) * 0.25 +
    worley3(x, y, z, cells * 4, seed + 41) * 0.125;
}

/** Tileable 3D value noise with a quintic fade. */
function value3(x: number, y: number, z: number, cells: number, seed: number): number {
  const fx = x * cells, fy = y * cells, fz = z * cells;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;

  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const ux = fade(tx), uy = fade(ty), uz = fade(tz);
  const wrap = (n: number): number => ((n % cells) + cells) % cells;

  const corner = (dx: number, dy: number, dz: number): number =>
    hash3(wrap(ix + dx), wrap(iy + dy), wrap(iz + dz), seed);

  const c000 = corner(0, 0, 0), c100 = corner(1, 0, 0);
  const c010 = corner(0, 1, 0), c110 = corner(1, 1, 0);
  const c001 = corner(0, 0, 1), c101 = corner(1, 0, 1);
  const c011 = corner(0, 1, 1), c111 = corner(1, 1, 1);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

function valueFbm(x: number, y: number, z: number, cells: number, seed: number): number {
  return value3(x, y, z, cells, seed) * 0.533 +
    value3(x, y, z, cells * 2, seed + 7) * 0.267 +
    value3(x, y, z, cells * 4, seed + 13) * 0.133 +
    value3(x, y, z, cells * 8, seed + 29) * 0.067;
}

const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  c + ((v - a) / (b - a)) * (d - c);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function generateCloudNoise(
  gl: WebGL2RenderingContext,
  onProgress?: (fraction: number) => void,
): CloudNoise {
  // --- shape ---
  const shapeData = new Uint8Array(SHAPE_SIZE * SHAPE_SIZE * SHAPE_SIZE * 4);

  for (let z = 0; z < SHAPE_SIZE; z++) {
    const w = (z + 0.5) / SHAPE_SIZE;
    for (let y = 0; y < SHAPE_SIZE; y++) {
      const v = (y + 0.5) / SHAPE_SIZE;
      for (let x = 0; x < SHAPE_SIZE; x++) {
        const u = (x + 0.5) / SHAPE_SIZE;

        const perlin = valueFbm(u, v, w, 4, 1013);
        const worleyLow = worleyFbm(u, v, w, 4, 2003);

        // Perlin-Worley: the billowy Worley shape carved into the smoother
        // Perlin field. This is what gives clouds a rounded, cauliflower base
        // instead of the shapeless blobs plain fBm produces.
        const perlinWorley = clamp01(remap(perlin, worleyLow - 1, 1, 0, 1));

        const index = ((z * SHAPE_SIZE + y) * SHAPE_SIZE + x) * 4;
        shapeData[index] = Math.round(perlinWorley * 255);
        shapeData[index + 1] = Math.round(clamp01(worleyFbm(u, v, w, 6, 3011)) * 255);
        shapeData[index + 2] = Math.round(clamp01(worleyFbm(u, v, w, 12, 4013)) * 255);
        shapeData[index + 3] = Math.round(clamp01(worleyFbm(u, v, w, 24, 5021)) * 255);
      }
    }
    onProgress?.((z + 1) / (SHAPE_SIZE + DETAIL_SIZE));
  }

  // --- detail ---
  const detailData = new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * DETAIL_SIZE * 4);

  for (let z = 0; z < DETAIL_SIZE; z++) {
    const w = (z + 0.5) / DETAIL_SIZE;
    for (let y = 0; y < DETAIL_SIZE; y++) {
      const v = (y + 0.5) / DETAIL_SIZE;
      for (let x = 0; x < DETAIL_SIZE; x++) {
        const u = (x + 0.5) / DETAIL_SIZE;
        const index = ((z * DETAIL_SIZE + y) * DETAIL_SIZE + x) * 4;
        detailData[index] = Math.round(clamp01(worleyFbm(u, v, w, 4, 6029)) * 255);
        detailData[index + 1] = Math.round(clamp01(worleyFbm(u, v, w, 8, 7039)) * 255);
        detailData[index + 2] = Math.round(clamp01(worleyFbm(u, v, w, 16, 8053)) * 255);
        detailData[index + 3] = 255;
      }
    }
    onProgress?.((SHAPE_SIZE + z + 1) / (SHAPE_SIZE + DETAIL_SIZE));
  }

  const shape = upload3D(gl, shapeData, SHAPE_SIZE);
  const detail = upload3D(gl, detailData, DETAIL_SIZE);

  return { shape, detail, shapeSize: SHAPE_SIZE, detailSize: DETAIL_SIZE };
}

function upload3D(gl: WebGL2RenderingContext, data: Uint8Array, size: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Не удалось создать 3D-текстуру шума облаков');

  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, size, size, size);
  gl.texSubImage3D(
    gl.TEXTURE_3D, 0, 0, 0, 0, size, size, size,
    gl.RGBA, gl.UNSIGNED_BYTE, data,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_3D, null);

  return texture;
}

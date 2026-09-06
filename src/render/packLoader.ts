/**
 * Loading a LabPBR resource pack.
 *
 * LabPBR is the de-facto standard shader packs use, so any of the hundreds of
 * existing PBR packs works. It carries exactly the data the procedural
 * generator could only approximate: a real height field for parallax, a
 * measured F0 instead of the flat 0.04 assumption, emission, and subsurface
 * scattering for foliage.
 *
 * Channel layout (LabPBR 1.3):
 *
 *   foo.png     RGB   albedo, A alpha
 *   foo_n.png   RG    tangent normal XY (Z reconstructed)
 *               B     ambient occlusion
 *               A     height, 0 = deepest, 255 = surface
 *   foo_s.png   R     perceptual smoothness
 *               G     0..229 = F0 reflectance, 230..255 = metal index
 *               B     0..64 porosity, 65..255 subsurface scattering
 *               A     0..254 emission, 255 = none
 *
 * Files are extracted from an archive ahead of time by
 * `scripts/extract-pack.mjs`, so the runtime only does plain fetches.
 */

export interface PackMeta {
  source: string;
  description: string;
  extracted: string;
  materials: string[];
  /** Materials the pack does not supply; these stay procedural. */
  procedural: string[];
}

/** One material decoded into the three layers the engine uploads. */
export interface PackedMaterial {
  /** RGB albedo + alpha, sRGB-encoded. */
  albedo: Uint8Array;
  /** RG tangent normal, B perceptual roughness, A ambient occlusion. */
  surface: Uint8Array;
  /** R height, G F0, B subsurface, A emission. */
  material: Uint8Array;
  size: number;
}

const PACK_ROOT = 'pack';

/**
 * Stretches and smooths a height field, in place, over the R channel of an
 * RGBA byte array.
 *
 * Packs are wildly inconsistent here. Roundista, for one, ships every material
 * inside 245..255 — four per cent of the range — which is enough to derive a
 * normal from but leaves parallax with nothing to march against.
 *
 * The first version of this function stretched that to the full range with a
 * gain of up to twenty-four and stopped there. `scripts/packheight.mjs` shows
 * what it was stretching: the field is not compressed relief at all, it is a
 * near-binary mask of rounded blobs — three tones, hard edges, one blob per
 * texture pixel. That is the "rounded blocks" look the pack is named for, drawn
 * as a stencil rather than as a surface. Amplified twenty-four times and
 * marched by parallax it came out as rows of hard beads with the block edge
 * slicing straight through them, which is exactly what the ground and the snow
 * looked like in game.
 *
 * So the stretch now does two things:
 *
 *   * the gain is capped low, because a field quantised to ten levels has ten
 *     levels no matter how far it is stretched, and every level past that is a
 *     terrace parallax will find and draw;
 *   * the result is blurred, which is what turns a stencil back into a
 *     surface. The blur wraps, because every material tiles.
 *
 * Guard unchanged: a field flatter than a few levels was never authored, and
 * amplifying dither noise into a rock face helps nobody. Those stay flat, and
 * parallax is a no-op for them.
 */
export function normalizeHeight(rgba: Uint8Array, size: number): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const h = rgba[i];
    if (h < min) min = h;
    if (h > max) max = h;
  }

  const span = max - min;
  if (span < 4) return;

  const gain = Math.min(255 / span, HEIGHT_GAIN_LIMIT);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.min(255, Math.round((rgba[i] - min) * gain));
  }

  // Only a field that needed the stretch gets the blur. A material that already
  // used a decent slice of the range authored real relief, and softening that
  // would throw away detail the pack meant to have. The procedural set is on
  // this side of the test, which is why its materials come through untouched.
  if (span >= QUANTISED_SPAN) return;

  // Blur radius scales with the tile: the blobs are one texture pixel across at
  // any resolution, so what has to be softened is a fixed fraction of the tile,
  // not a fixed number of texels.
  blurHeightWrapped(rgba, size, Math.max(1, Math.round(size / 64)));
}

/** Below this span a height field is a quantised stencil, not authored relief. */
const QUANTISED_SPAN = 64;

/**
 * How far a compressed height field may be stretched.
 *
 * Six, not twenty-four. The number that matters is not the range the pack used
 * but the number of distinct levels inside it, and no stretch creates levels.
 */
const HEIGHT_GAIN_LIMIT = 6;

/**
 * Separable box blur of the R channel, run twice so the kernel is triangular
 * rather than boxy, with wrap-around addressing because materials tile.
 */
function blurHeightWrapped(rgba: Uint8Array, size: number, radius: number): void {
  if (radius < 1) return;

  const pixels = size * size;
  const scratch = new Uint16Array(pixels);
  const source = new Uint16Array(pixels);
  for (let p = 0; p < pixels; p++) source[p] = rgba[p * 4];

  const width = radius * 2 + 1;

  for (let pass = 0; pass < 2; pass++) {
    // Horizontal.
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += source[row + ((x + k + size) % size)];
        }
        scratch[row + x] = Math.round(sum / width);
      }
    }
    // Vertical.
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += scratch[((y + k + size) % size) * size + x];
        }
        source[y * size + x] = Math.round(sum / width);
      }
    }
  }

  for (let p = 0; p < pixels; p++) rgba[p * 4] = source[p];
}

/** Reads the manifest written by the extraction script, or null if absent. */
export async function loadPackMeta(baseUrl = PACK_ROOT): Promise<PackMeta | null> {
  try {
    const response = await fetch(`${baseUrl}/pack.json`, { cache: 'force-cache' });
    if (!response.ok) return null;
    return (await response.json()) as PackMeta;
  } catch {
    return null;
  }
}

/** Decodes one PNG into raw RGBA bytes at its native size. */
async function readImage(url: string): Promise<{ data: Uint8ClampedArray; size: number } | null> {
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) return null;
    // No premultiplication and no colour management: three of the four
    // channels in `_n` and `_s` are data, not colour, and both conversions
    // would quietly rewrite them.
    const bitmap = await createImageBitmap(await response.blob(), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });

    // Packs sometimes ship animated textures as a vertical strip of frames;
    // take the first square frame so the tile stays 1:1.
    const size = Math.min(bitmap.width, bitmap.height);

    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, size, size, 0, 0, size, size);
    bitmap.close();

    return { data: context.getImageData(0, 0, size, size).data, size };
  } catch {
    return null;
  }
}

/**
 * Loads and decodes one material.
 *
 * Returns null when the base texture is missing; a missing `_n` or `_s` is
 * tolerated and filled with neutral defaults, because plenty of packs are
 * incomplete and one absent map should not disqualify the material.
 */
export async function loadPackMaterial(
  name: string,
  baseUrl = PACK_ROOT,
): Promise<PackedMaterial | null> {
  const base = await readImage(`${baseUrl}/${name}.png`);
  if (!base) return null;

  const size = base.size;
  const pixels = size * size;

  const [normalMap, specularMap] = await Promise.all([
    readImage(`${baseUrl}/${name}_n.png`),
    readImage(`${baseUrl}/${name}_s.png`),
  ]);

  const albedo = new Uint8Array(pixels * 4);
  const surface = new Uint8Array(pixels * 4);
  const material = new Uint8Array(pixels * 4);

  albedo.set(base.data);

  for (let p = 0; p < pixels; p++) {
    const i = p * 4;

    // --- normal / AO / height ---
    if (normalMap && normalMap.size === size) {
      const n = normalMap.data;
      surface[i] = n[i];
      surface[i + 1] = n[i + 1];
      surface[i + 3] = n[i + 2];      // B of the normal map is ambient occlusion
      material[i] = n[i + 3];         // A is the height field
    } else {
      surface[i] = 128;               // flat normal
      surface[i + 1] = 128;
      surface[i + 3] = 255;           // unoccluded
      material[i] = 255;              // height at the surface: parallax is a no-op
    }

    // --- smoothness / F0 / subsurface / emission ---
    if (specularMap && specularMap.size === size) {
      const s = specularMap.data;
      // LabPBR stores perceptual *smoothness*; the engine works in roughness.
      surface[i + 2] = 255 - s[i];

      const f0 = s[i + 1];
      // 230..255 is a metal index rather than a reflectance value. Treating
      // every metal as "F0 = albedo" is the standard simplification and is
      // indistinguishable here, where metals are ore blocks seen at a distance.
      material[i + 1] = f0 >= 230 ? 255 : f0;
      material[i + 2] = s[i + 2];
      // 255 means "no emission", which is not the same as full brightness.
      material[i + 3] = s[i + 3] === 255 ? 0 : s[i + 3];
    } else {
      surface[i + 2] = 200;           // fairly rough
      material[i + 1] = 10;           // F0 ~ 0.04, the dielectric default
      material[i + 2] = 0;
      material[i + 3] = 0;
    }
  }

  normalizeHeight(material, size);

  return { albedo, surface, material, size };
}

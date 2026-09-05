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
    const bitmap = await createImageBitmap(await response.blob());

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

  return { albedo, surface, material, size };
}

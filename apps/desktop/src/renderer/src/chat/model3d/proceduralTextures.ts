import * as THREE from 'three';
import type { ModelTexture, ModelUnits } from '@shared/model3d';

/**
 * Procedural surface detail for a part's `texture`: wood grain and brushed metal, generated from
 * seeded noise rather than shipped as images, so there is no asset to license and every build looks
 * the same. Each texture tiles seamlessly; its u axis runs along the grain or the brushing.
 *
 * The colour map is a grey tone the part's own colour is multiplied by, so `color` still decides
 * the species or the metal. The roughness map multiplies `roughness` the same way.
 */

/** Texels per side: enough for close-ups, small enough to generate in a few tens of ms. */
export const TEXTURE_SIZE = 512;

/** How long one repeat of each texture is on the model, in mm: a board's grain, a sheet's brushing. */
const TILE_MM: Record<ModelTexture, number> = { wood: 300, brushed: 120 };

/**
 * Bump strength for a mm model. three perturbs normals per unit of surface length, so a model in
 * metres (lengths a thousandth as long) needs a thousandth of the strength to look the same.
 */
const BUMP_MM: Record<ModelTexture, number> = { wood: 0.6, brushed: 0.15 };

/** A uniform 0..1 from a lattice point; Math.imul keeps it 32-bit and the same on every machine. */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** Value noise in 0..1 that repeats every `periodX` by `periodY` lattice cells, so a tile has no seam. */
export function tileableNoise(x: number, y: number, periodX: number, periodY: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const at = (dx: number, dy: number) => hash(wrap(x0 + dx, periodX), wrap(y0 + dy, periodY), seed);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * tx;
  const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * tx;
  return top + (bottom - top) * ty;
}

/** Octaves of tileable noise over one tile (u, v in 0..1), `cellsU` by `cellsV` cells at the base octave. */
function fbm(u: number, v: number, cellsU: number, cellsV: number, octaves: number, seed: number): number {
  let sum = 0;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = 2 ** octave;
    const amplitude = 0.5 ** octave;
    sum +=
      amplitude * tileableNoise(u * cellsU * scale, v * cellsV * scale, cellsU * scale, cellsV * scale, seed + octave);
    weight += amplitude;
  }
  return sum / weight;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (edge0: number, edge1: number, value: number) => fade(clamp01((value - edge0) / (edge1 - edge0)));

/** One texel: the tone the colour is multiplied by, the roughness multiplier, and the bump height. */
type Texel = { tone: number; roughness: number; height: number };

/** Plain-sawn grain: growth rings warped by slow noise, darker late wood, and fine pores along u. */
function woodTexel(u: number, v: number): Texel {
  const RINGS = 16;
  const warp = fbm(u, v, 2, 3, 4, 11);
  const ring = v * RINGS + warp * 1.6;
  const phase = ring - Math.floor(ring);
  // A thin dark line of late wood with soft edges, not a sawtooth that steps at every ring.
  const late = smoothstep(0.6, 0.9, phase) * (1 - smoothstep(0.92, 1, phase));
  const pores = fbm(u, v, 6, 140, 2, 23);
  const figure = fbm(u, v, 3, 3, 3, 37);
  return {
    tone: clamp01(0.97 - 0.26 * late - 0.2 * (pores - 0.5) - 0.1 * (figure - 0.5)),
    roughness: clamp01(0.85 + 0.15 * late + 0.1 * (pores - 0.5)),
    height: clamp01(0.55 * (1 - late) + 0.45 * pores),
  };
}

/** Brushed sheet: hairline streaks along u over a faint mottle. */
function brushedTexel(u: number, v: number): Texel {
  const streaks = fbm(u, v, 4, 320, 3, 53);
  const mottle = fbm(u, v, 3, 3, 3, 71);
  return {
    tone: clamp01(0.93 + 0.1 * (streaks - 0.5) - 0.05 * (mottle - 0.5)),
    roughness: clamp01(0.8 + 0.4 * (streaks - 0.5) + 0.1 * (mottle - 0.5)),
    height: streaks,
  };
}

const TEXELS: Record<ModelTexture, (u: number, v: number) => Texel> = { wood: woodTexel, brushed: brushedTexel };

/** The three maps of a texture, as RGBA bytes, TEXTURE_SIZE square. Roughness rides in green, as glTF reads it. */
export function textureBytes(kind: ModelTexture): { color: Uint8Array; roughness: Uint8Array; height: Uint8Array } {
  const texel = TEXELS[kind];
  const count = TEXTURE_SIZE * TEXTURE_SIZE;
  const color = new Uint8Array(count * 4);
  const roughness = new Uint8Array(count * 4);
  const height = new Uint8Array(count * 4);
  for (let row = 0; row < TEXTURE_SIZE; row += 1) {
    for (let column = 0; column < TEXTURE_SIZE; column += 1) {
      const { tone, roughness: rough, height: bump } = texel(column / TEXTURE_SIZE, row / TEXTURE_SIZE);
      const offset = (row * TEXTURE_SIZE + column) * 4;
      color.fill(Math.round(tone * 255), offset, offset + 3);
      roughness.fill(255, offset, offset + 3);
      roughness[offset + 1] = Math.round(rough * 255);
      height.fill(Math.round(bump * 255), offset, offset + 3);
      color[offset + 3] = roughness[offset + 3] = height[offset + 3] = 255;
    }
  }
  return { color, roughness, height };
}

function dataTexture(bytes: Uint8Array, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(bytes, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // Grain seen at a glancing angle along a long board stays crisp rather than smearing.
  texture.anisotropy = 8;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

type TextureSet = { map: THREE.DataTexture; roughnessMap: THREE.DataTexture; bumpMap: THREE.DataTexture };

// Generated once per kind and shared by every part and material that uses it.
const generated = new Map<ModelTexture, TextureSet>();

export function textureSet(kind: ModelTexture): TextureSet {
  const cached = generated.get(kind);
  if (cached) return cached;
  const bytes = textureBytes(kind);
  const set = {
    map: dataTexture(bytes.color, THREE.SRGBColorSpace),
    roughnessMap: dataTexture(bytes.roughness, THREE.NoColorSpace),
    bumpMap: dataTexture(bytes.height, THREE.NoColorSpace),
  };
  generated.set(kind, set);
  return set;
}

/** Puts `kind`'s maps on a part's material; brushed metal also stretches its highlights across the brushing. */
export function applyTexture(material: THREE.MeshPhysicalMaterial, kind: ModelTexture, units: ModelUnits): void {
  const { map, roughnessMap, bumpMap } = textureSet(kind);
  material.map = map;
  material.roughnessMap = roughnessMap;
  material.bumpMap = bumpMap;
  material.bumpScale = BUMP_MM[kind] * (units === 'm' ? 0.001 : 1);
  if (kind === 'brushed') material.anisotropy = 0.75;
}

/** The axis (0 x, 1 y, 2 z) a part is longest along, which wood grain and brushing follow. */
export function longestAxis(geometry: THREE.BufferGeometry): 0 | 1 | 2 {
  geometry.computeBoundingBox();
  const size = (geometry.boundingBox ?? new THREE.Box3()).getSize(new THREE.Vector3()).toArray();
  return size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
}

/**
 * Box-projects UVs onto a non-indexed geometry: each triangle takes the two axes its face is most
 * square-on to, with u along the part's longest axis where that is one of them, so grain runs down
 * a plank and round a box's sides. One UV unit is one texture tile, sized in real length.
 */
export function boxProjectUvs(geometry: THREE.BufferGeometry, kind: ModelTexture, units: ModelUnits): void {
  if (geometry.index) throw new Error('boxProjectUvs needs a non-indexed geometry, one triangle per three vertices.');
  const position = geometry.getAttribute('position');
  const tile = TILE_MM[kind] / (units === 'm' ? 1000 : 1);
  const grain = longestAxis(geometry);
  const uv = new Float32Array(position.count * 2);
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  for (let first = 0; first + 2 < position.count; first += 3) {
    corners.forEach((corner, index) => corner.fromBufferAttribute(position, first + index));
    normal.subVectors(corners[1], corners[0]).cross(edge.subVectors(corners[2], corners[0]));
    const facing = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const across = facing.indexOf(Math.max(...facing));
    const [a, b] = [0, 1, 2].filter(axis => axis !== across);
    const [uAxis, vAxis] = b === grain ? [b, a] : [a, b];
    corners.forEach((corner, index) => {
      const coordinates = corner.toArray();
      uv[(first + index) * 2] = coordinates[uAxis] / tile;
      uv[(first + index) * 2 + 1] = coordinates[vAxis] / tile;
    });
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

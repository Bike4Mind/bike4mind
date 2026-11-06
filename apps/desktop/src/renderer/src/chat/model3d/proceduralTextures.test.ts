import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildModelObject } from './modelScene';
import { boxProjectUvs, longestAxis, TEXTURE_SIZE, textureBytes, tileableNoise } from './proceduralTextures';

const toneAt = (bytes: Uint8Array, column: number, row: number) => bytes[(row * TEXTURE_SIZE + column) * 4];

describe('tileableNoise', () => {
  it('repeats every period, so a tile has no seam', () => {
    for (const [x, y] of [
      [0.3, 0.7],
      [2.5, 1.25],
    ])
      expect(tileableNoise(x + 4, y + 3, 4, 3, 9)).toBeCloseTo(tileableNoise(x, y, 4, 3, 9));
  });
});

describe('textureBytes', () => {
  it.each(['wood', 'brushed'] as const)('makes the same %s every time, varied and seamless', kind => {
    const { color, roughness } = textureBytes(kind);
    expect(color).toEqual(textureBytes(kind).color);
    const tones = new Set(Array.from({ length: 64 }, (_, index) => toneAt(color, index * 8, index * 8)));
    expect(tones.size).toBeGreaterThan(8);
    // The last column runs on into the first, and the last row into the first.
    let jump = 0;
    for (let index = 0; index < TEXTURE_SIZE; index += 1) {
      jump += Math.abs(toneAt(color, TEXTURE_SIZE - 1, index) - toneAt(color, 0, index));
      jump += Math.abs(toneAt(color, index, TEXTURE_SIZE - 1) - toneAt(color, index, 0));
    }
    expect(jump / (2 * TEXTURE_SIZE)).toBeLessThan(24);
    // Roughness rides in the green channel, as glTF reads it.
    expect(roughness[0]).toBe(255);
    expect(roughness[1]).toBeLessThanOrEqual(255);
  });
});

describe('boxProjectUvs', () => {
  const plank = () => new THREE.BoxGeometry(300, 20, 40).toNonIndexed();

  it('runs u along the longest axis on the faces that contain it', () => {
    const geometry = plank();
    expect(longestAxis(geometry)).toBe(0);
    boxProjectUvs(geometry, 'wood', 'mm');
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    // Every vertex on a face facing y or z takes u from its x: one tile is 300 mm of wood.
    for (let index = 0; index < position.count; index += 3) {
      const facesX =
        Math.abs(position.getX(index) - position.getX(index + 1)) < 1e-6 &&
        Math.abs(position.getX(index) - position.getX(index + 2)) < 1e-6;
      if (facesX) continue;
      expect(uv.getX(index)).toBeCloseTo(position.getX(index) / 300);
    }
  });

  it('sizes the tile in real length whatever the units', () => {
    const geometry = new THREE.BoxGeometry(0.3, 0.02, 0.04).toNonIndexed();
    boxProjectUvs(geometry, 'wood', 'm');
    const uv = geometry.getAttribute('uv');
    const us = Array.from({ length: uv.count }, (_, index) => uv.getX(index));
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1);
  });

  it('refuses an indexed geometry, whose shared corners cannot take one projection per face', () => {
    expect(() => boxProjectUvs(new THREE.BoxGeometry(1, 1, 1), 'wood', 'mm')).toThrow(/non-indexed/);
  });

  it('is applied by buildModelObject to textured parts only', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 5, 0, 0, 5, 0, 0, 0, 5, 10, 0, 5, 10, 5, 5, 0, 5, 5]);
    const indices = new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]);
    const root = buildModelObject(
      [
        { name: 'plank', color: '#9a6a3c', positions, indices, texture: 'wood' },
        { name: 'plain', color: '#888888', positions, indices, smooth: true },
      ],
      'mm'
    );
    const geometryOf = (name: string) => (root.getObjectByName(name) as THREE.Mesh).geometry;
    expect(geometryOf('plank').getAttribute('uv')).toBeDefined();
    expect(geometryOf('plain').getAttribute('uv')).toBeUndefined();
  });
});

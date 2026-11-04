// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ModelPartMesh } from '@shared/model3d';
import { buildModelObject, exportGlb, loadAsset, partsToStl, summarizeObject, summarizeParts } from './modelScene';

/** An axis-aligned box from 0 to (x, y, z): 8 corners, 12 triangles, wound outward. */
function box(name: string, x: number, y: number, z: number): ModelPartMesh {
  const positions = new Float32Array([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { name, color: '#8b5a2b', positions, indices };
}

describe('summarizeParts', () => {
  it('reports size in model axes, triangles and param values', () => {
    const summary = summarizeParts(
      [box('body', 60, 40, 30)],
      { width: { value: 60, min: 1, max: 100, step: 1 } },
      'mm'
    );
    expect(summary).toEqual({ parts: ['body'], size: [60, 40, 30], units: 'mm', triangles: 12, params: { width: 60 } });
  });
});

describe('partsToStl', () => {
  it('writes a binary STL of 84 + 50 bytes per triangle with an outward normal', () => {
    const stl = partsToStl([box('a', 1, 1, 1), box('b', 2, 2, 2)]);
    expect(stl.byteLength).toBe(84 + 50 * 24);
    const view = new DataView(stl.buffer);
    expect(view.getUint32(80, true)).toBe(24);
    // First triangle is the bottom face (z = 0), so its normal points down.
    expect(view.getFloat32(84 + 8, true)).toBeCloseTo(-1);
  });
});

describe('buildModelObject / summarizeObject', () => {
  it('keeps model axes when summarizing the Y-up scene object', () => {
    const root = buildModelObject([box('body', 60, 40, 30)], 'mm');
    const summary = summarizeObject(root);
    expect(summary.size[0]).toBeCloseTo(60);
    expect(summary.size[1]).toBeCloseTo(40);
    expect(summary.size[2]).toBeCloseTo(30);
    expect(summary.parts).toEqual(['body']);
    expect(summary.triangles).toBe(12);
  });
});

describe('exportGlb', () => {
  it('writes a binary glTF scaled to metres that loads back', async () => {
    const glb = await exportGlb(buildModelObject([box('body', 1000, 500, 250)], 'mm'));
    expect(new TextDecoder().decode(glb.slice(0, 4))).toBe('glTF');
    const loaded = summarizeObject(await loadAsset('glb', glb));
    expect(loaded.size[0]).toBeCloseTo(1);
    expect(loaded.size[1]).toBeCloseTo(0.5);
    expect(loaded.size[2]).toBeCloseTo(0.25);
    expect(loaded.units).toBe('m');
  });
});

describe('loadAsset (stl)', () => {
  it('round-trips an exported STL as millimetres', async () => {
    const summary = summarizeObject(await loadAsset('stl', partsToStl([box('a', 10, 20, 30)])));
    expect(summary.units).toBe('mm');
    expect(summary.size[0]).toBeCloseTo(10);
    expect(summary.size[2]).toBeCloseTo(30);
  });
});

import { describe, expect, it } from 'vitest';
import { formatModelSummary, modelKindFor, siblingGlbPath, writeParamValue } from './model3d';

const SOURCE = `export const units = 'mm';

export const params = {
  width: { value: 60, min: 20, max: 200, step: 1 },
  lidRatio: { value: 0.35, min: 0.1, max: 0.6, step: 0.05 },
};

export default function model({ m, p }) {
  const width = { value: 1 };
  return m.Manifold.cube([p.width, 40, 30], true);
}
`;

describe('modelKindFor', () => {
  it('maps supported extensions and refuses the rest', () => {
    expect(modelKindFor('/a/chest.model.js')).toBe('model');
    expect(modelKindFor('/a/CHEST.GLB')).toBe('glb');
    expect(modelKindFor('/a/b.gltf')).toBe('gltf');
    expect(modelKindFor('/a/b.stl')).toBe('stl');
    expect(modelKindFor('/a/b.js')).toBeNull();
    expect(modelKindFor('/a/b.txt')).toBeNull();
  });
});

describe('siblingGlbPath', () => {
  it('swaps the .model.js suffix for .glb in place', () => {
    expect(siblingGlbPath('/proj/assets/chest.model.js')).toBe('/proj/assets/chest.glb');
  });
});

describe('writeParamValue', () => {
  it('rewrites only the named param value', () => {
    const next = writeParamValue(SOURCE, 'width', 80);
    expect(next).toContain('width: { value: 80, min: 20');
    expect(next).toContain('lidRatio: { value: 0.35');
    // The same key outside the params export is left alone.
    expect(next).toContain('const width = { value: 1 }');
  });

  it('handles fractional values', () => {
    expect(writeParamValue(SOURCE, 'lidRatio', 0.45)).toContain('lidRatio: { value: 0.45');
  });

  it('returns null when the key is missing', () => {
    expect(writeParamValue(SOURCE, 'height', 10)).toBeNull();
  });

  it('returns null when the key matches twice', () => {
    const doubled = SOURCE.replace('lidRatio:', 'width:');
    expect(writeParamValue(doubled, 'width', 10)).toBeNull();
  });

  it('returns null without a params export or for a non-finite value', () => {
    expect(writeParamValue('export default () => null', 'width', 10)).toBeNull();
    expect(writeParamValue(SOURCE, 'width', Number.NaN)).toBeNull();
  });
});

describe('formatModelSummary', () => {
  it('describes a successful build with units and the GLB path', () => {
    const text = formatModelSummary(
      {
        generation: 1,
        ok: true,
        summary: { parts: ['body', 'lid'], size: [60, 40, 30.004], units: 'mm', triangles: 24, params: { width: 60 } },
      },
      '/proj/chest.glb'
    );
    expect(text).toContain('Size: 60 x 40 x 30 mm');
    expect(text).toContain('Parts: body, lid');
    expect(text).toContain('Params: width=60');
    expect(text).toContain('GLB written: /proj/chest.glb');
  });

  it('describes a failure with its line', () => {
    const text = formatModelSummary({ generation: 2, ok: false, error: 'boom is not defined', line: 7 });
    expect(text).toContain('Build failed (line 7): boom is not defined');
  });
});

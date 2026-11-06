import { describe, expect, it } from 'vitest';
import {
  describeJoints,
  jointsOf,
  formatModelSummary,
  modelKindFor,
  partTreeError,
  siblingGlbPath,
  writeParamValue,
  type ModelPartMesh,
} from './model3d';

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
    // A .gltf points at sibling .bin and image files the sandboxed loader cannot reach.
    expect(modelKindFor('/a/b.gltf')).toBeNull();
    expect(modelKindFor('/a/b.stl')).toBe('stl');
    expect(modelKindFor('/a/b.js')).toBeNull();
    expect(modelKindFor('/a/b.txt')).toBeNull();
  });
});

describe('siblingGlbPath', () => {
  it('swaps the .model.js suffix for .glb in place', () => {
    expect(siblingGlbPath('/proj/assets/chest.model.js')).toBe('/proj/assets/chest.glb');
  });

  it('has no sibling for a file that is not a .model.js', () => {
    expect(siblingGlbPath('/proj/assets/chest.glb')).toBeNull();
    expect(siblingGlbPath('/proj/assets/chest.stl')).toBeNull();
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

  it('refuses a value that is an expression rather than a plain number', () => {
    expect(writeParamValue(SOURCE.replace('value: 60,', 'value: 10 * 2,'), 'width', 80)).toBeNull();
  });

  it('accepts exponent notation, including what toPrecision writes for large values', () => {
    expect(writeParamValue(SOURCE.replace('value: 60,', 'value: 1e+3,'), 'width', 80)).toContain('value: 80,');
    const huge = writeParamValue(SOURCE, 'width', 1e21);
    expect(huge).toContain('value: 1e+21,');
    expect(writeParamValue(huge ?? '', 'width', 70)).toContain('value: 70,');
  });

  it('matches quoted keys but not a hyphenated key that ends in the name', () => {
    const quoted = SOURCE.replace('width:', "'width':");
    expect(writeParamValue(quoted, 'width', 80)).toContain("'width': { value: 80,");
    const hyphen = SOURCE.replace('width:', "'outer-width':");
    expect(writeParamValue(hyphen, 'width', 80)).toBeNull();
    const both = hyphen.replace('lidRatio:', '"width":');
    expect(writeParamValue(both, 'width', 0.5)).toContain('"width": { value: 0.5,');
    expect(writeParamValue(both, 'width', 0.5)).toContain("'outer-width': { value: 60,");
  });

  it('handles fractional values', () => {
    expect(writeParamValue(SOURCE, 'lidRatio', 0.45)).toContain('lidRatio: { value: 0.45');
  });

  it('rewrites a param given as a bare number', () => {
    const bare = SOURCE.replace('width: { value: 60, min: 20, max: 200, step: 1 }', 'width: 40');
    const next = writeParamValue(bare, 'width', 55);
    expect(next).toContain('width: 55,');
    expect(next).toContain('const width = { value: 1 }');
    expect(writeParamValue(bare.replace('lidRatio:', 'width:'), 'width', 10)).toBeNull();
  });

  it("ignores another param's fields when matching a bare key", () => {
    const step = 'export const params = { step: { value: 2 }, width: { value: 10, min: 1, step: 1 } };\n';
    expect(writeParamValue(step, 'step', 3)).toBe(
      'export const params = { step: { value: 3 }, width: { value: 10, min: 1, step: 1 } };\n'
    );
    const min = 'export const params = { min: { value: 2 * 3 }, width: { value: 10, min: 1 } };\n';
    expect(writeParamValue(min, 'min', 9)).toBeNull();
  });

  it('is not thrown off by braces or keys inside strings and comments', () => {
    const labelled = [
      'export const params = {',
      "  width: { value: 10, label: '{w} mm' }, // set {width: 5} here",
      '  /* depth: { value: 1 } */ depth: 4,',
      '  note: "width: 7",',
      '};',
      '',
    ].join('\n');
    expect(writeParamValue(labelled, 'width', 12)).toBe(labelled.replace('value: 10', 'value: 12'));
    expect(writeParamValue(labelled, 'depth', 6)).toBe(labelled.replace('depth: 4', 'depth: 6'));
  });

  it('finds the value past a label with braces, or a value: in a comment, that comes first', () => {
    const labelFirst = SOURCE.replace('width: { value: 60,', "width: { label: '{w} mm', value: 60,");
    expect(writeParamValue(labelFirst, 'width', 70)).toContain("width: { label: '{w} mm', value: 70,");
    const commentFirst = SOURCE.replace('width: { value: 60,', 'width: { /* value: 3 */ value: 60,');
    expect(writeParamValue(commentFirst, 'width', 70)).toContain('width: { /* value: 3 */ value: 70,');
    const nested = SOURCE.replace('width: { value: 60,', 'width: { meta: { value: 1 }, value: 60,');
    expect(writeParamValue(nested, 'width', 70)).toContain('meta: { value: 1 }, value: 70,');
    const ternary = SOURCE.replace('width: { value: 60,', 'width: { min: fine ? value : 3, value: 60,');
    expect(writeParamValue(ternary, 'width', 70)).toContain('width: { min: fine ? value : 3, value: 70,');
    const commented = SOURCE.replace('width: { value: 60,', 'width: { min: 1, // note\n value: 60,');
    expect(writeParamValue(commented, 'width', 70)).toContain('// note\n value: 70,');
  });

  it('refuses an object param with no value field of its own', () => {
    const noValue = 'export const params = { width: { min: 1 }, depth: { value: 4 } };\n';
    expect(writeParamValue(noValue, 'width', 3)).toBeNull();
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

  it('says why the GLB was not written instead of naming a stale one', () => {
    const text = formatModelSummary(
      {
        generation: 1,
        ok: true,
        glbError: 'EACCES: permission denied',
        summary: { parts: ['body'], size: [1, 1, 1], units: 'mm', triangles: 2, params: {} },
      },
      '/proj/chest.glb'
    );
    expect(text).toContain('GLB not written: EACCES: permission denied');
    expect(text).not.toContain('GLB written:');
  });

  it('describes a failure with its line', () => {
    const text = formatModelSummary({ generation: 2, ok: false, error: 'boom is not defined', line: 7 });
    expect(text).toContain('Build failed (line 7): boom is not defined');
  });
});

function part(name: string, extra: Partial<ModelPartMesh> = {}): ModelPartMesh {
  return { name, color: '#fff', positions: new Float32Array(), indices: new Uint32Array(), ...extra };
}

describe('partTreeError', () => {
  it('accepts a lid pivoted inside its body, whatever the order', () => {
    expect(partTreeError([part('lid', { parent: 'body', pivot: [0, 20, 30] }), part('body')])).toBeNull();
  });

  it.each([
    [[part('lid', { parent: 'chest' })], 'names a parent "chest" that no part is called'],
    [[part('lid', { parent: 'lid' })], 'cannot be its own parent'],
    [[part('a', { parent: 'b' }), part('b', { parent: 'a' })], 'form a loop'],
    [[part('body'), part('body'), part('lid', { parent: 'body' })], 'that 2 parts are called'],
    [[part('lid', { pivot: [0, Number.NaN, 1] as [number, number, number] })], 'not three numbers'],
    [[part('lid', { pivot: [0, 0, 0], range: [0, 90] })], 'a range but no axis'],
    [[part('lid', { pivot: [0, 0, 0], axis: [0, 0, 0], range: [0, 90] })], 'not a direction'],
    [[part('lid', { pivot: [0, 0, 0], axis: [1, 0, 0] })], 'no range'],
    [
      [part('lid', { pivot: [0, 0, 0], axis: [1, 0, 0], range: [45, 45] })],
      'two different values [from, to] in degrees',
    ],
    [[part('lid', { axis: [1, 0, 0], range: [0, 90] })], 'no pivot to turn about'],
    [[part('drawer', { motion: 'slide', range: [0, 40] })], 'a range but no axis to move along'],
    [[part('drawer', { motion: 'slide', axis: [0, 1, 0], range: [5, 5] })], 'in model units'],
    [[part('drawer', { motion: 'spin' as 'slide', axis: [0, 1, 0], range: [0, 40] })], 'not one of: turn, slide'],
  ])('refuses %#', (parts, message) => {
    expect(partTreeError(parts)).toContain(message);
  });

  it.each([
    [part('knob', { metalness: 1.5 }), 'metalness that is not a number from 0 to 1'],
    [part('knob', { roughness: Number.NaN }), 'roughness that is not a number from 0 to 1'],
    [part('knob', { smooth: 'yes' as unknown as boolean }), 'smooth that is not true or false'],
  ])('refuses a material %#', (bad, message) => {
    expect(partTreeError([bad])).toContain(message);
  });

  it('accepts a metal, smooth part', () => {
    expect(partTreeError([part('knob', { metalness: 1, roughness: 0.4, smooth: true })])).toBeNull();
  });

  it('accepts a slide without a pivot', () => {
    expect(partTreeError([part('drawer', { motion: 'slide', axis: [0, -1, 0], range: [0, 40] })])).toBeNull();
  });
});

describe('jointsOf', () => {
  it('lists the parts with an axis and range, and only those', () => {
    const lid = part('lid', { pivot: [0, 20, 30], parent: 'body', axis: [1, 0, 0], range: [0, 110] });
    expect(jointsOf([part('body'), lid, part('lock', { parent: 'lid' })])).toEqual([
      { name: 'lid', motion: 'turn', axis: [1, 0, 0], range: [0, 110] },
    ]);
  });
});

describe('describeJoints', () => {
  it('says how a joint turns', () => {
    const lid = part('lid', { pivot: [0, 20, 30], parent: 'body', axis: [-1, 0, 0], range: [0, 110] });
    expect(describeJoints([lid])).toEqual([
      'lid: pivot (0, 20, 30), in body, turns about (-1, 0, 0) from 0 to 110 deg',
    ]);
  });

  it('says how a slide moves, with no pivot', () => {
    const drawer = part('drawer', { parent: 'body', motion: 'slide', axis: [0, -1, 0], range: [0, 40] });
    expect(describeJoints([drawer])).toEqual(['drawer: no pivot, in body, slides along (0, -1, 0) from 0 to 40']);
  });

  it('lists only parts with a pivot or parent', () => {
    expect(describeJoints([part('body'), part('lid', { pivot: [0, 24.5, 38], parent: 'body' })])).toEqual([
      'lid: pivot (0, 24.5, 38), in body',
    ]);
  });

  it('shows in the tool summary', () => {
    const text = formatModelSummary({
      generation: 1,
      ok: true,
      summary: {
        parts: ['body', 'lid'],
        size: [1, 1, 1],
        units: 'mm',
        triangles: 2,
        params: {},
        joints: ['lid: pivot (0, 1, 2), in body'],
      },
    });
    expect(text).toContain('Joints: lid: pivot (0, 1, 2), in body');
  });
});

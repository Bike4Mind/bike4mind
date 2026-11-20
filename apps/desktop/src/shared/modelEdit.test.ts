import { describe, expect, it } from 'vitest';
import type { ModelPartMesh } from './model3d';
import {
  declarationLine,
  formatModelEditNote,
  lineRanges,
  modelEditContext,
  modelEditSummary,
  partFacts,
} from './modelEdit';

const SOURCE = [
  'const wall = 2;', // 1
  'export default function model({ m }) {', // 2
  '  const { Manifold } = m;', // 3
  '  const body = Manifold.cylinder(60, 20).subtract(Manifold.cylinder(60, 20 - wall));', // 4
  '  const lid = Manifold.cylinder(8, 22).translate([0, 0, 60]);', // 5
  '  return [', // 6
  "    { name: 'body', color: '#888', shape: body },", // 7
  '    { name: "lid", color: "#b5862b", shape: lid },', // 8
  '  ];', // 9
  '}', // 10
].join('\n');

function mesh(name: string, points: number[], lines?: number[]): ModelPartMesh {
  return {
    name,
    color: '#fff',
    positions: new Float32Array(points),
    indices: new Uint32Array(),
    ...(lines ? { lines } : {}),
  };
}

const FACTS = partFacts([
  mesh('body', [-20, -20, 0, 20, 20, 60], [4]),
  mesh('lid', [-22, -22, 60, 22, 22, 68], [4, 5]),
]);

describe('lineRanges', () => {
  it('collapses runs and keeps singles', () => {
    expect(lineRanges([9, 2, 3, 4, 12, 13])).toBe('2-4, 9, 12-13');
    expect(lineRanges([7])).toBe('7');
  });
});

describe('declarationLine', () => {
  it('finds the name on a name key, in either quote style', () => {
    expect(declarationLine(SOURCE, 'body')).toBe(7);
    expect(declarationLine(SOURCE, 'lid')).toBe(8);
  });

  it('is undefined for a name built at runtime', () => {
    expect(declarationLine(SOURCE, 'leg3')).toBeUndefined();
  });

  it('treats regex characters in a name literally', () => {
    expect(declarationLine("return [{ name: 'a.b', shape }];", 'a.b')).toBe(1);
    expect(declarationLine("return [{ name: 'axb', shape }];", 'a.b')).toBeUndefined();
  });
});

describe('partFacts', () => {
  it('keeps the bounds and provenance lines of each part', () => {
    expect(FACTS).toEqual([
      { name: 'body', lines: [4], min: [-20, -20, 0], max: [20, 20, 60] },
      { name: 'lid', lines: [4, 5], min: [-22, -22, 60], max: [22, 22, 68] },
    ]);
  });
});

describe('modelEditContext', () => {
  it('maps a picked part to its lines, its listing and the lines it shares', () => {
    const context = modelEditContext({
      path: '/work/lantern.model.js',
      source: SOURCE,
      units: 'mm',
      facts: FACTS,
      picked: ['lid', 'missing'],
      closeup: 'model-edit-lid.png',
    });
    expect(context).toEqual({
      path: '/work/lantern.model.js',
      units: 'mm',
      parts: [{ name: 'lid', lines: [4, 5], declaredAt: 8, min: [-22, -22, 60], max: [22, 22, 68] }],
      sharedLines: [4],
      closeup: 'model-edit-lid.png',
    });
  });
});

describe('formatModelEditNote', () => {
  it('carries the file, lines, bounds in mm and the rebuild rule', () => {
    const note = formatModelEditNote(
      modelEditContext({
        path: '/work/lantern.model.js',
        source: SOURCE,
        units: 'mm',
        facts: FACTS,
        picked: ['lid'],
        closeup: 'model-edit-lid.png',
      })
    );
    expect(note).toContain('in /work/lantern.model.js');
    expect(note).toContain(
      '- lid: listed at line 8; built by lines 4-5 (4 also builds other parts); bounds x -22..22, y -22..22, z 60..68 mm, size 44 x 44 x 8 mm.'
    );
    expect(note).toContain('call model_view in a later batch (never in the same batch as the save)');
    expect(note).toContain('model_screenshot');
    expect(note).toContain('The attached model-edit-lid.png is a close-up');
  });

  it('converts metre models to mm and falls back to the name when nothing was traced', () => {
    const note = formatModelEditNote({
      path: '/work/shed.model.js',
      units: 'm',
      parts: [{ name: 'roof', lines: [], min: [0, 0, 2], max: [3, 2, 2.5] }],
      sharedLines: [],
    });
    expect(note).toContain(
      '- roof: not listed by a literal name; no source lines were traced, so find it by its name; bounds x 0..3000, y 0..2000, z 2000..2500 mm, size 3000 x 2000 x 500 mm.'
    );
    expect(note).not.toContain('close-up');
  });
});

describe('modelEditSummary', () => {
  it('reads the parts and close-up back from a sent note', () => {
    const note = formatModelEditNote(
      modelEditContext({
        path: '/p.model.js',
        source: SOURCE,
        units: 'mm',
        facts: FACTS,
        picked: ['body', 'lid'],
        closeup: 'c.png',
      })
    );
    expect(modelEditSummary(['an unrelated note', note])).toEqual({ parts: ['body', 'lid'], closeup: 'c.png' });
  });

  it('is null for a turn without one, or a malformed one', () => {
    expect(modelEditSummary(undefined)).toBeNull();
    expect(modelEditSummary(['Point-and-edit request from the 3D model pane.\nParts: not json'])).toBeNull();
  });
});

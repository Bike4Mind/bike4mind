import { describe, it, expect } from 'vitest';
import {
  buildSupersessionReport,
  describeSupersession,
  partitionBySupersession,
  type SupersedableFile,
} from './supersession';

const LAKE1 = { id: 'lake1', datalakeTag: 'datalake:lake1' };
const LAKE2 = { id: 'lake2', datalakeTag: 'datalake:lake2' };
const LAKES = [LAKE1, LAKE2];

const file = (over: Partial<SupersedableFile> & { id: string }): SupersedableFile => ({
  fileName: 'spec.md',
  fileTags: ['datalake:lake1'],
  createdAt: new Date('2024-01-01'),
  ...over,
});

const idsOf = (files: readonly { id: string }[]) => files.map(f => f.id);

describe('partitionBySupersession', () => {
  it('collapses same-key members in one lake down to the newest', () => {
    const { servable, superseded } = partitionBySupersession(
      [file({ id: 'old', createdAt: new Date('2024-01-01') }), file({ id: 'new', createdAt: new Date('2024-06-01') })],
      { lakes: LAKES }
    );
    expect(idsOf(servable)).toEqual(['new']);
    expect(superseded).toEqual([
      { file: expect.objectContaining({ id: 'old' }), tier: 'fileName', supersededBy: 'new' },
    ]);
  });

  it('never collapses across lakes, even for an identical file name', () => {
    const { servable, superseded } = partitionBySupersession(
      [
        file({ id: 'a', fileTags: ['datalake:lake1'] }),
        file({ id: 'b', fileTags: ['datalake:lake2'], createdAt: new Date('2024-06-01') }),
      ],
      { lakes: LAKES }
    );
    expect(idsOf(servable)).toEqual(['a', 'b']);
    expect(superseded).toEqual([]);
  });

  it('breaks an equal-createdAt tie by ascending id, not by scope order', () => {
    const at = new Date('2024-03-03');
    const forward = partitionBySupersession([file({ id: 'b1', createdAt: at }), file({ id: 'a1', createdAt: at })], {
      lakes: LAKES,
    });
    const reversed = partitionBySupersession([file({ id: 'a1', createdAt: at }), file({ id: 'b1', createdAt: at })], {
      lakes: LAKES,
    });
    expect(idsOf(forward.servable)).toEqual(['a1']);
    expect(idsOf(reversed.servable)).toEqual(['a1']);
  });

  it('passes unattributable members through untouched', () => {
    const { servable, superseded } = partitionBySupersession(
      [file({ id: 'x', fileTags: ['personal:draft'] }), file({ id: 'y', fileTags: [] })],
      { lakes: LAKES }
    );
    expect(idsOf(servable)).toEqual(['x', 'y']);
    expect(superseded).toEqual([]);
  });

  it('passes multi-lake members through untouched - "the same document" has no single scope there', () => {
    const both = ['datalake:lake1', 'datalake:lake2'];
    const { servable, superseded } = partitionBySupersession(
      [file({ id: 'm1', fileTags: both }), file({ id: 'm2', fileTags: both, createdAt: new Date('2025-01-01') })],
      { lakes: LAKES }
    );
    expect(idsOf(servable)).toEqual(['m1', 'm2']);
    expect(superseded).toEqual([]);
  });

  it('never collapses when no lakes are in scope at all', () => {
    const { servable, superseded } = partitionBySupersession(
      [file({ id: 'p' }), file({ id: 'q', createdAt: new Date('2025-01-01') })],
      { lakes: [] }
    );
    expect(idsOf(servable)).toEqual(['p', 'q']);
    expect(superseded).toEqual([]);
  });

  describe('identity tiers', () => {
    it('groups by relativePath + fileName, so the same name in two folders stays separate', () => {
      const { servable, superseded } = partitionBySupersession(
        [
          file({ id: 'docsA', fileName: 'README.md', relativePath: 'docs' }),
          file({ id: 'srcA', fileName: 'README.md', relativePath: 'src' }),
          file({ id: 'docsB', fileName: 'README.md', relativePath: 'docs', createdAt: new Date('2025-05-05') }),
        ],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['srcA', 'docsB']);
      expect(superseded).toEqual([
        { file: expect.objectContaining({ id: 'docsA' }), tier: 'relativePath', supersededBy: 'docsB' },
      ]);
    });

    it('collapses on the bare fileName tier when neither member carries a relativePath', () => {
      const { superseded } = partitionBySupersession(
        [
          file({ id: 'r1', fileName: 'README.md' }),
          file({ id: 'r2', fileName: 'README.md', createdAt: new Date('2025-05-05') }),
        ],
        { lakes: LAKES }
      );
      expect(superseded.map(e => [e.file.id, e.tier])).toEqual([['r1', 'fileName']]);
    });

    it('driveFileId takes precedence over a differing relativePath - a moved Drive file is one document', () => {
      const { servable, superseded } = partitionBySupersession(
        [
          file({ id: 'd1', driveFileId: 'drive-1', relativePath: 'old/folder', fileName: 'plan.docx' }),
          file({
            id: 'd2',
            driveFileId: 'drive-1',
            relativePath: 'new/folder',
            fileName: 'plan-v2.docx',
            createdAt: new Date('2025-07-07'),
          }),
        ],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['d2']);
      expect(superseded.map(e => e.tier)).toEqual(['driveFileId']);
    });

    it('does not collapse two files that share a relativePath but not a name', () => {
      const { superseded } = partitionBySupersession(
        [
          file({ id: 'n1', fileName: 'a.md', relativePath: 'docs' }),
          file({ id: 'n2', fileName: 'b.md', relativePath: 'docs' }),
        ],
        { lakes: LAKES }
      );
      expect(superseded).toEqual([]);
    });

    it('attributes a static-registry lake through its open prefix, not just the meta-tag', () => {
      const staticLake = { id: 'opti-knowledge', datalakeTag: 'datalake:opti-knowledge', fileTagPrefix: 'opti:' };
      const { servable, superseded } = partitionBySupersession(
        [
          file({ id: 's1', fileTags: ['opti:policy'] }),
          file({ id: 's2', fileTags: ['opti:policy'], createdAt: new Date('2025-02-02') }),
        ],
        { lakes: [staticLake] }
      );
      expect(idsOf(servable)).toEqual(['s2']);
      expect(idsOf(superseded.map(e => e.file))).toEqual(['s1']);
    });
  });

  describe('missing fields', () => {
    it('treats a missing createdAt as oldest without throwing', () => {
      const { servable, superseded } = partitionBySupersession(
        [file({ id: 'dated', createdAt: new Date('2020-01-01') }), file({ id: 'undated', createdAt: undefined })],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['dated']);
      expect(idsOf(superseded.map(e => e.file))).toEqual(['undated']);
    });

    it('falls back to the id tie-break when both members are undated', () => {
      const { servable } = partitionBySupersession(
        [file({ id: 'zz', createdAt: null }), file({ id: 'aa', createdAt: undefined })],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['aa']);
    });

    it('accepts an ISO string createdAt', () => {
      const { servable } = partitionBySupersession(
        [
          file({ id: 'i1', createdAt: '2024-01-01T00:00:00.000Z' }),
          file({ id: 'i2', createdAt: '2025-01-01T00:00:00.000Z' }),
        ],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['i2']);
    });

    it('groups an empty relativePath on the bare fileName tier rather than on an empty path', () => {
      const { superseded } = partitionBySupersession(
        [
          file({ id: 'e1', relativePath: '' }),
          file({ id: 'e2', relativePath: undefined, createdAt: new Date('2025-01-01') }),
        ],
        { lakes: LAKES }
      );
      expect(superseded.map(e => [e.file.id, e.tier])).toEqual([['e1', 'fileName']]);
    });

    it('leaves a nameless, driveless member alone instead of grouping every one of them together', () => {
      const { servable, superseded } = partitionBySupersession(
        [file({ id: 'u1', fileName: undefined }), file({ id: 'u2', fileName: undefined })],
        { lakes: LAKES }
      );
      expect(idsOf(servable)).toEqual(['u1', 'u2']);
      expect(superseded).toEqual([]);
    });
  });
});

describe('buildSupersessionReport / describeSupersession', () => {
  const supersededOf = (count: number) =>
    partitionBySupersession(
      [
        ...Array.from({ length: count }, (_, i) =>
          file({ id: `old${i}`, fileName: `f${i}.md`, createdAt: new Date('2020-01-01') })
        ),
        ...Array.from({ length: count }, (_, i) =>
          file({ id: `new${i}`, fileName: `f${i}.md`, createdAt: new Date('2025-01-01') })
        ),
      ],
      { lakes: LAKES }
    ).superseded;

  it('reports nothing when nothing was suppressed', () => {
    const report = buildSupersessionReport([]);
    expect(report).toEqual({ count: 0, sample: [], partial: false });
    expect(describeSupersession(report)).toBeNull();
  });

  it('names suppressed ids, the winner and the tier', () => {
    const report = buildSupersessionReport(supersededOf(1));
    expect(report.count).toBe(1);
    expect(report.sample[0]).toEqual({
      fileId: 'old0',
      fileName: 'f0.md',
      tier: 'fileName',
      supersededBy: 'new0',
    });
    const prose = describeSupersession(report);
    expect(prose).toContain('old0');
    expect(prose).toContain('new0');
    expect(prose).toContain('fileName');
  });

  it('keeps the count exact while capping the sample', () => {
    const report = buildSupersessionReport(supersededOf(9));
    expect(report.count).toBe(9);
    expect(report.sample).toHaveLength(5);
    expect(describeSupersession(report)).toContain(', ...');
  });
});

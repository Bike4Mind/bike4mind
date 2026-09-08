import { describe, expect, it } from 'vitest';
import {
  assertAllAttributed,
  assertSupersessionSampleAttributed,
  attributeChunks,
  supersededCountFor,
  tallyGenerations,
  type ChunkAttribution,
  type SearchHit,
  type SeededFile,
} from './supersessionAttribution';

const seeded = (fabFileId: string, generation: 'OLD' | 'NEW'): SeededFile => ({
  fabFileId,
  fileName: 'Expense Policy.txt',
  generation,
  docIndex: 0,
});

const hit = (chunkId: string, fileId: string, overrides: Partial<SearchHit> = {}): SearchHit => ({
  chunkId,
  fileId,
  fileName: 'Expense Policy.txt',
  score: 0.9,
  ...overrides,
});

const chunk = (generation: ChunkAttribution['generation'], fabFileId = 'f1'): ChunkAttribution => ({
  chunkId: `c-${fabFileId}`,
  fabFileId,
  fileName: 'Expense Policy.txt',
  generation,
  score: 0.9,
});

const byId = (...files: SeededFile[]) => new Map(files.map(f => [f.fabFileId, f]));

describe('attributeChunks', () => {
  it('attributes a hit to the generation seeding recorded for its fileId', () => {
    const chunks = attributeChunks(
      [hit('c1', 'old-1'), hit('c2', 'new-1')],
      byId(seeded('old-1', 'OLD'), seeded('new-1', 'NEW'))
    );
    expect(chunks.map(c => c.generation)).toEqual(['OLD', 'NEW']);
  });

  it('marks a hit from an unseeded file UNKNOWN rather than guessing a generation', () => {
    const chunks = attributeChunks([hit('c1', 'stranger')], byId(seeded('old-1', 'OLD')));
    expect(chunks[0]).toMatchObject({ generation: 'UNKNOWN', fabFileId: 'stranger' });
  });

  it('prefers the seeded fileName over the search result, so a mid-run rename cannot split a document', () => {
    const chunks = attributeChunks([hit('c1', 'old-1', { fileName: 'Renamed.txt' })], byId(seeded('old-1', 'OLD')));
    expect(chunks[0].fileName).toBe('Expense Policy.txt');
  });

  it('falls back to the search result fileName when there is nothing seeded to name it', () => {
    const chunks = attributeChunks([hit('c1', 'stranger', { fileName: 'Other Lake.txt' })], byId());
    expect(chunks[0].fileName).toBe('Other Lake.txt');
  });

  it('carries chunkId and score through untouched', () => {
    const chunks = attributeChunks([hit('c1', 'old-1', { score: 0.4242 })], byId(seeded('old-1', 'OLD')));
    expect(chunks[0]).toMatchObject({ chunkId: 'c1', score: 0.4242 });
  });
});

describe('assertAllAttributed', () => {
  it('passes on a clean run', () => {
    expect(() => assertAllAttributed([chunk('OLD', 'a'), chunk('NEW', 'b')], 'collapse=off')).not.toThrow();
  });

  it('passes on an empty result, which the probe guards separately', () => {
    expect(() => assertAllAttributed([], 'collapse=on')).not.toThrow();
  });

  it('refuses a run carrying an unattributed chunk, naming the offending file', () => {
    expect(() => assertAllAttributed([chunk('NEW', 'b'), chunk('UNKNOWN', 'stranger')], 'collapse=on')).toThrow(
      /stranger/
    );
  });

  it('names the context so the operator knows which configuration was contaminated', () => {
    expect(() => assertAllAttributed([chunk('UNKNOWN', 'stranger')], 'collapse=on')).toThrow(/^collapse=on/);
  });

  it('deduplicates offenders by file, since one file contributes many chunks', () => {
    const chunks = [
      { ...chunk('UNKNOWN', 'stranger'), chunkId: 'c1' },
      { ...chunk('UNKNOWN', 'stranger'), chunkId: 'c2' },
    ];
    expect(() => assertAllAttributed(chunks, 'collapse=off')).toThrow(/served 2 chunk\(s\) from 1 FabFile\(s\)/);
  });

  it('enumerates every distinct offender, not just the first, so the operator chases all of them', () => {
    const chunks = [
      { ...chunk('UNKNOWN', 'stranger'), chunkId: 'c1' },
      { ...chunk('UNKNOWN', 'stranger'), chunkId: 'c2' },
      { ...chunk('UNKNOWN', 'interloper'), chunkId: 'c3' },
    ];
    const refuse = () => assertAllAttributed(chunks, 'collapse=off');
    expect(refuse).toThrow(/served 3 chunk\(s\) from 2 FabFile\(s\)/);
    expect(refuse).toThrow(/stranger/);
    expect(refuse).toThrow(/interloper/);
  });
});

describe('tallyGenerations', () => {
  it('counts each generation separately', () => {
    const tally = tallyGenerations([chunk('OLD', 'a'), chunk('OLD', 'b'), chunk('NEW', 'c')]);
    expect(tally).toEqual({ oldCount: 2, newCount: 1, unknownCount: 0 });
  });

  it('reports UNKNOWN chunks instead of dropping them, so they cannot hide inside a total', () => {
    const tally = tallyGenerations([chunk('NEW', 'a'), chunk('UNKNOWN', 'stranger')]);
    expect(tally).toEqual({ oldCount: 0, newCount: 1, unknownCount: 1 });
  });

  it('is all zeroes on an empty result', () => {
    expect(tallyGenerations([])).toEqual({ oldCount: 0, newCount: 0, unknownCount: 0 });
  });
});

describe('assertSupersessionSampleAttributed', () => {
  const sample = (fileId: string, fileName?: string) => ({ fileId, fileName });

  it('passes when every superseded file was seeded by this run', () => {
    expect(() =>
      assertSupersessionSampleAttributed([sample('old-1')], byId(seeded('old-1', 'OLD')), 'collapse=on')
    ).not.toThrow();
  });

  it('passes on an empty report, which collapse=off produces by definition', () => {
    expect(() => assertSupersessionSampleAttributed([], byId(seeded('old-1', 'OLD')), 'collapse=off')).not.toThrow();
  });

  it('refuses a superseded file this run did not seed, since no served chunk can reveal it', () => {
    expect(() =>
      assertSupersessionSampleAttributed(
        [sample('old-1'), sample('foreign-1', 'Other Lake.txt')],
        byId(seeded('old-1', 'OLD')),
        'collapse=on'
      )
    ).toThrow(/foreign-1/);
  });

  it('names the context and counts the offenders', () => {
    expect(() =>
      assertSupersessionSampleAttributed([sample('foreign-1'), sample('foreign-2')], byId(), 'collapse=on')
    ).toThrow(/^collapse=on reported 2 superseded file\(s\) from 2 FabFile\(s\)/);
  });
});

describe('supersededCountFor', () => {
  const q = (count: number) => ({ supersession: { count } });

  it('reports the single per-configuration count rather than the sum across queries', () => {
    expect(supersededCountFor([q(3), q(3), q(3)], 'collapse=on')).toBe(3);
  });

  it('is zero when a configuration ran no queries', () => {
    expect(supersededCountFor([], 'collapse=off')).toBe(0);
  });

  it('refuses a divergent count rather than picking one, naming the query that disagreed', () => {
    expect(() => supersededCountFor([q(3), q(3), q(4)], 'collapse=on')).toThrow(
      /query 0 reported 3, query 2 reported 4/
    );
  });
});

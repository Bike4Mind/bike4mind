import { describe, expect, it } from 'vitest';
import {
  applicableWidths,
  compareArms,
  compareFromRaw,
  formatComparison,
  reportFromRaw,
  resolveQueries,
  assertSameCorpus,
} from './modelComparison';
import { loadEmbeddingFixture, type EmbeddingFixture } from './embeddingFixture';
import tinyFixture from './fixtures/tiny-comparison.fixture.json';

/**
 * The committed fixture is SYNTHETIC - random vectors with a planted topical structure. It exists to
 * exercise the arithmetic and the rendering end to end without credentials. No number it produces is
 * a measurement of any embedding model, and nothing here asserts a quality claim from it.
 */
const fixture = loadEmbeddingFixture(tinyFixture);
const other = (over: Partial<EmbeddingFixture>): EmbeddingFixture => ({ ...fixture, ...over });

describe('assertSameCorpus', () => {
  it('accepts fixtures over one corpus', () => {
    expect(() => assertSameCorpus([fixture, other({ model: 'another-model' })])).not.toThrow();
  });

  it('refuses to table two arms measured over different lakes', () => {
    expect(() => assertSameCorpus([fixture, other({ corpus: 'some-other-lake' })])).toThrow(/different corpora/);
  });
});

describe('resolveQueries', () => {
  it('joins the fixture to the committed ground truth by question id', () => {
    const queries = resolveQueries(fixture);
    expect(queries).toHaveLength(5);
    expect(queries.find(q => q.id === 'q01')?.supporting).toEqual(['features/organizations-teams']);
    expect(queries.find(q => q.id === 'n03')?.supporting).toEqual([]);
  });

  it('throws on a query id with no ground truth rather than quietly scoring fewer questions', () => {
    // A dropped question shrinks the set for ONE arm, and an arm scored on fewer or easier
    // questions reads as a better model.
    const bad = other({ queries: [...fixture.queries, { id: 'q99', vector: fixture.queries[0].vector }] });
    expect(() => resolveQueries(bad)).toThrow(/q99/);
  });
});

describe('compareArms', () => {
  it('builds one row per fixture per applicable width, widest first', () => {
    const rows = compareArms([fixture], [16, 8, 4]);
    expect(rows.map(r => r.arm)).toEqual([
      'synthetic-eval-embedding@16',
      'synthetic-eval-embedding@8',
      'synthetic-eval-embedding@4',
    ]);
  });

  it('skips a width wider than the capture instead of throwing', () => {
    // Asking for 3072,1536,512 means "every width that applies"; 3072 does not apply to a 1536-dim
    // capture of 3-small, and omitting that row is the correct reading of the request.
    expect(compareArms([fixture], [3072, 16, 8]).map(r => r.arm)).toEqual([
      'synthetic-eval-embedding@16',
      'synthetic-eval-embedding@8',
    ]);
  });

  it('throws when no requested width applies at all', () => {
    expect(() => compareArms([fixture], [3072, 1536])).toThrow(/every one exceeds the capture/);
  });

  it('throws rather than dropping one fixture of several from the table', () => {
    // The hazard the per-fixture check exists for: the report renders, looks complete, and silently
    // compares one fewer model than the command named.
    const narrow = other({ model: 'text-embedding-3-small', dims: 8 });
    expect(() => compareArms([fixture, narrow], [16])).toThrow(/has no arm at any of the requested widths/);
  });

  it('gives a non-Matryoshka capture exactly one arm, at its capture width', () => {
    // The runbook's own step 3 passes the ada-002 baseline alongside --widths 3072,1536,512. A
    // truncated ada-002 prefix is not an embedding, and it would render indistinguishably from a
    // legitimate 3-small@512 row.
    const ada = other({ model: 'text-embedding-ada-002' });
    expect(compareArms([ada], [3072, 1536, 512]).map(r => r.arm)).toEqual(['text-embedding-ada-002@16']);
  });

  it('keeps that arm even when the width list omits the capture width', () => {
    // The baseline is the arm the instrument check is read off; it must not vanish on a width typo.
    const ada = other({ model: 'text-embedding-ada-002' });
    expect(applicableWidths(ada, [512])).toEqual([16]);
    expect(compareArms([ada], [512]).map(r => r.arm)).toEqual(['text-embedding-ada-002@16']);
  });

  it('scores every arm over the same question set and the same corpus counters', () => {
    const rows = compareArms([fixture], [16, 8]);
    expect(new Set(rows.map(r => r.queries))).toEqual(new Set([5]));
    expect(new Set(rows.map(r => r.chunksScored))).toEqual(new Set([21]));
    expect(rows.every(r => r.filesInScope === 7 && r.chunksExcluded === 2 && r.filesExcluded === 1)).toBe(true);
  });

  it('produces a real band and per-query spreads, not placeholders', () => {
    const [row] = compareArms([fixture], [16]);
    expect(row.band.width).toBeGreaterThan(0);
    expect(row.spreads).toHaveLength(5);
    expect(row.spreads.every(s => s > 0)).toBe(true);
    expect(row.band.max).toBeLessThanOrEqual(1);
    expect(row.band.min).toBeGreaterThanOrEqual(-1);
  });

  it('tables two models over one corpus', () => {
    const rows = compareArms([fixture, other({ model: 'other-embedder' })], [16]);
    expect(rows.map(r => r.arm)).toEqual(['synthetic-eval-embedding@16', 'other-embedder@16']);
  });

  it('throws on a fixture with no queries rather than rendering an empty row', () => {
    expect(() => compareArms([other({ queries: [] })], [16])).toThrow(/no queries/);
  });
});

describe('compareFromRaw', () => {
  it('validates raw JSON before scoring it', () => {
    expect(() => compareFromRaw([tinyFixture], [16])).not.toThrow();
    expect(() => compareFromRaw([{ ...tinyFixture, dims: 8 }], [8])).toThrow(/another width/);
  });
});

describe('reportFromRaw', () => {
  it('renders the CLI report from raw JSON, carrying the capture-level notes', () => {
    const report = reportFromRaw([tinyFixture], [16, 8]);
    expect(report).toContain('arm                  : synthetic-eval-embedding@16');
    expect(report).toContain('retrieval_unavailable: 3 files unreachable');
  });

  it('raises the corpus-regime gate where the verdict is read, not only on the capture stdout', () => {
    const shortFacts = {
      ...tinyFixture,
      chunks: tinyFixture.chunks.map(c => ({ ...c, charLength: 180 })),
    };
    expect(reportFromRaw([shortFacts], [16])).toContain('NOT THE LONG-DOCUMENT REGIME');
    expect(reportFromRaw([tinyFixture], [16])).not.toContain('NOT THE LONG-DOCUMENT REGIME');
  });

  it('says a non-Matryoshka arm ignored the requested widths, rather than staying silent', () => {
    const ada = { ...tinyFixture, model: 'text-embedding-ada-002' };
    const report = reportFromRaw([ada], [3072, 1536, 512]);
    expect(report).toContain('SCORED AT CAPTURE WIDTH ONLY (text-embedding-ada-002@16)');
    expect(report).not.toContain('text-embedding-ada-002@512');
  });
});

describe('formatComparison', () => {
  const report = formatComparison(compareArms([fixture], [16, 8]));

  it('renders end to end from the committed fixture, with a block per arm and one table', () => {
    expect(report).toContain('arm                  : synthetic-eval-embedding@16');
    expect(report).toContain('arm                  : synthetic-eval-embedding@8');
    expect(report).toContain('files_in_scope       : 7');
    expect(report).toContain('overall band         : ');
    // The cross-arm table header appears exactly once, under both blocks.
    expect(report.split('band min').length - 1).toBe(1);
  });

  it('carries the exact-kNN caveat, so the number is never read as the served path', () => {
    expect(report).toContain('NOT the ANN path prod measured through');
  });

  it('is deterministic - the same fixture renders the same report', () => {
    expect(formatComparison(compareArms([fixture], [16, 8]))).toBe(report);
  });
});

describe('ground-truth applicability in the report', () => {
  it('says so in the clear when the corpus has no ground truth', () => {
    // Every docId replaced with a file-id-shaped value, as a production-lake capture would produce.
    const byId = other({
      chunks: fixture.chunks.map((c, i) => ({ ...c, docId: `67f0a1b2c3d4e5f60000000${i % 10}` })),
    });
    const report = formatComparison(compareArms([byId], [16]));
    expect(report).toContain('GROUND TRUTH DOES NOT DESCRIBE THIS CORPUS');
    expect(report).toContain('and so do posTop/negTop');
    // The band is still a real measurement on such a capture, so it must not be suppressed.
    expect(report).toMatch(/overall band {9}: -?\d/);
  });

  it('stays quiet when the ground truth does describe the corpus', () => {
    expect(formatComparison(compareArms([fixture], [16]))).not.toContain('GROUND TRUTH DOES NOT');
  });
});

describe('differing chunk sets across arms', () => {
  it('warns when one arm scored a different number of chunks than another', () => {
    // The shape a --reuse-stored-vectors baseline produces: it keeps only stamped chunks, while an
    // embedded arm covers the whole lake. The two bands then describe different corpora.
    const baseline = other({ model: 'baseline', chunks: fixture.chunks.slice(0, 12) });
    const report = formatComparison(compareArms([baseline, fixture], [16]));
    expect(report).toContain('ARMS COVER DIFFERENT CHUNK SETS (12 vs 21 chunks)');
  });

  it('stays quiet when every arm covered the same chunks', () => {
    expect(formatComparison(compareArms([fixture, other({ model: 'b' })], [16]))).not.toContain('ARMS COVER DIFFERENT');
  });
});

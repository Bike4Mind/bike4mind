import { describe, expect, it } from 'vitest';
import {
  applicableWidths,
  compareArms,
  compareFromRaw,
  formatComparison,
  reportFromRaw,
  resolveQueries,
  assertSameCorpus,
  assertSameQuerySet,
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

describe('assertSameQuerySet', () => {
  it('accepts fixtures carrying the same question ids in any order', () => {
    expect(() => assertSameQuerySet([fixture, other({ queries: [...fixture.queries].reverse() })])).not.toThrow();
  });

  it('refuses a fixture scored on fewer questions than its neighbour', () => {
    // resolveQueries cannot see this: every id it holds IS in corpus.ts, there are just fewer of
    // them - and no table column would have shown 4 questions beside 5.
    const short = other({ queries: fixture.queries.slice(0, -1) });
    expect(() => assertSameQuerySet([fixture, short])).toThrow(/different question sets/);
  });

  it('refuses two same-size fixtures whose question ids differ', () => {
    // The count check a reader would reach for first passes here, which is why the compare is on sets.
    const swapped = other({
      queries: [...fixture.queries.slice(0, -1), { ...fixture.queries[0], id: 'q05' }],
    });
    expect(swapped.queries).toHaveLength(fixture.queries.length);
    expect(() => assertSameQuerySet([fixture, swapped])).toThrow(/different question sets/);
  });

  it('is enforced by compareArms, not only available to it', () => {
    expect(() => compareArms([fixture, other({ queries: fixture.queries.slice(0, 2) })], [16])).toThrow(
      /different question sets/
    );
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
    const bad = other({ queries: [...fixture.queries, { ...fixture.queries[0], id: 'q99' }] });
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

  it('scores two model arms independently when their vectors genuinely differ', () => {
    // The relabelled-fixture test above pins the LABELS. It cannot pin the scoring, because both arms
    // hold byte-identical vectors - and this repository has been bitten by exactly that shape before
    // (b4m-core/memory/src/eval/dimensions.test.ts records an earlier "512 == 1536" claim that passed
    // tautologically because it compared identical vectors). A shared orthogonal transform would be
    // the same trap: cosine is invariant under one. So each chunk gets its OWN cyclic shift, which
    // keeps every vector unit-norm while changing the geometry between chunks.
    const shift = (v: number[], k: number) => [...v.slice(k % v.length), ...v.slice(0, k % v.length)];
    const secondModel = other({
      model: 'other-embedder',
      chunks: fixture.chunks.map((c, i) => ({ ...c, vector: shift(c.vector, i + 1) })),
    });
    const [base, arm] = compareArms([fixture, secondModel], [16]);
    expect(arm.arm).toBe('other-embedder@16');
    expect(arm.chunksScored).toBe(base.chunksScored);
    expect(arm.band.width).not.toBeCloseTo(base.band.width, 6);
    expect(arm.meanTopScore).not.toBeCloseTo(base.meanTopScore, 6);
    expect(arm.spreads).not.toEqual(base.spreads);
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

  it('refuses width arms for a fixture whose model the registry does not know and which is not declared synthetic', () => {
    // A hand-edited or typo'd fixture reaching the comparison path: the schema validates `model` as
    // a non-empty string, so nothing before this point can tell it from a real capture.
    const typo = { ...tinyFixture, model: 'text-embedding-ada-oo2', syntheticMatryoshka: undefined };
    const report = reportFromRaw([typo], [16, 8]);
    expect(report).toContain('SCORED AT CAPTURE WIDTH ONLY (text-embedding-ada-oo2@16)');
    expect(report).not.toContain('text-embedding-ada-oo2@8');
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
    expect(formatComparison(compareArms([fixture], [16]))).not.toContain('ONLY PARTLY DESCRIBES');
  });

  it('names the arms the ground truth does not describe, rather than stating it table-wide', () => {
    // quality() gates per row, so on a mixed set the table-wide phrasing printed "reads n/a" above
    // arms whose cells are real numbers.
    const unlabelled = other({
      model: 'unlabelled',
      chunks: fixture.chunks.map((c, i) => ({ ...c, docId: `67f0a1b2c3d4e5f60000000${i % 10}` })),
    });
    const report = formatComparison(compareArms([fixture, unlabelled], [16]));
    expect(report).toContain('GROUND TRUTH DOES NOT DESCRIBE THIS CORPUS (unlabelled@16)');
    expect(report).not.toContain('synthetic-eval-embedding@16): no captured document');
  });

  it('names the coverage fraction when the corpus holds only part of the ground truth', () => {
    // One shared slug passes the all-or-nothing flag above, and then recall is bounded by the
    // corpus rather than by the model - which is the reading that flag exists to prevent.
    const partial = other({
      chunks: fixture.chunks.map((c, i) =>
        c.docId === 'features/organizations-teams' ? c : { ...c, docId: `67f0a1b2c3d4e5f60000000${i % 10}` }
      ),
    });
    const report = formatComparison(compareArms([partial], [16]));
    expect(report).toContain(
      'GROUND TRUTH ONLY PARTLY DESCRIBES THIS CORPUS (synthetic-eval-embedding@16: 1 of 5 supporting documents'
    );
    expect(report).not.toContain('GROUND TRUTH DOES NOT DESCRIBE');
  });

  it("reports every partial arm's own fraction, not whichever fixture came first", () => {
    // The shape a --reuse-stored-vectors baseline produces: it drops a whole doc whose chunks are
    // unlabeled, so its coverage sits below the embed arm's and one printed fraction is wrong for
    // the other row.
    const drop = (docs: readonly string[]) =>
      fixture.chunks.map((c, i) => (docs.includes(c.docId) ? { ...c, docId: `67f0a1b2c3d4e5f60000000${i % 10}` } : c));
    const embedArm = other({ model: 'embedded', chunks: drop(['features/knowledge-management']) });
    const baseline = other({
      model: 'baseline',
      chunks: drop(['features/knowledge-management', 'features/organizations-teams']),
    });
    const report = formatComparison(compareArms([embedArm, baseline], [16]));
    expect(report).toContain('embedded@16: ');
    expect(report).toContain('baseline@16: ');
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

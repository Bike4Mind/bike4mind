import { describe, expect, it } from 'vitest';
import {
  corpusRegime,
  deriveArm,
  formatCorpusRegime,
  hashQuestionText,
  isLongDocumentRegime,
  isTruncatableModel,
  loadEmbeddingFixture,
  PROD_REGIME_REFERENCE,
  type EmbeddingFixture,
} from './embeddingFixture';
import { PROBE_QUESTIONS } from './corpus';
import tinyFixture from './fixtures/tiny-comparison.fixture.json';

const hashOf = (id: string) => hashQuestionText(PROBE_QUESTIONS.find(q => q.id === id)!.question);

const base = (over: Partial<EmbeddingFixture> = {}): unknown => ({
  model: 'text-embedding-3-small',
  dims: 4,
  corpus: 'test',
  capturedAt: '2026-09-08T00:00:00.000Z',
  filesInScope: 1,
  chunksExcluded: 0,
  filesExcluded: 0,
  filesUnreachable: 0,
  chunks: [{ chunkId: 'c1', docId: 'docA', vector: [1, 0, 0, 0], charLength: 2200 }],
  queries: [{ id: 'q01', vector: [0, 1, 0, 0], questionHash: hashOf('q01') }],
  ...over,
});

const norm = (v: number[]) => Math.hypot(...v);

describe('loadEmbeddingFixture', () => {
  it('accepts a capture whose vectors are all the declared width', () => {
    const fixture = loadEmbeddingFixture(base());
    expect(fixture.dims).toBe(4);
    expect(fixture.chunks).toHaveLength(1);
  });

  it('throws when a chunk vector is not the declared width, instead of scoring noise', () => {
    // computeCosineSimilarity returns 0 for a width mismatch, which a ranking then discards as an
    // ordinary low score - so the table would render complete, confident and wrong.
    const bad = base({ chunks: [{ chunkId: 'c1', docId: 'docA', vector: [1, 0], charLength: 2200 }] } as never);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/another width/);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/chunk c1:2/);
  });

  it('throws on a query vector of the wrong width too, not just a chunk', () => {
    const bad = base({ queries: [{ id: 'q01', vector: [1, 0, 0], questionHash: hashOf('q01') }] } as never);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/query q01:3/);
  });

  it('rejects a structurally invalid capture rather than filling in defaults', () => {
    expect(() => loadEmbeddingFixture(base({ model: '' } as never))).toThrow();
    expect(() => loadEmbeddingFixture({ ...(base() as object), dims: undefined })).toThrow();
  });

  it('loads the committed synthetic fixture', () => {
    const fixture = loadEmbeddingFixture(tinyFixture);
    expect(fixture.dims).toBe(16);
    expect(fixture.chunks).toHaveLength(21);
    expect(fixture.queries).toHaveLength(5);
  });
});

describe('deriveArm', () => {
  const fixture = loadEmbeddingFixture(tinyFixture);

  it('names an arm by model AND width, because the width is part of the vector space', () => {
    expect(deriveArm(fixture, 8).arm).toBe('synthetic-eval-embedding@8');
    expect(deriveArm(fixture, 16).arm).toBe('synthetic-eval-embedding@16');
  });

  it('is a no-op at full width', () => {
    const full = deriveArm(fixture, 16);
    expect(full.chunks[0].vector).toEqual(fixture.chunks[0].vector);
    expect(full.queries[0].vector).toEqual(fixture.queries[0].vector);
  });

  it('returns unit-norm vectors at every narrower width', () => {
    for (const dims of [8, 4, 2]) {
      const arm = deriveArm(fixture, dims);
      expect(arm.chunks.every(c => c.vector.length === dims)).toBe(true);
      for (const c of arm.chunks) expect(norm(c.vector)).toBeCloseTo(1, 10);
      for (const q of arm.queries) expect(norm(q.vector)).toBeCloseTo(1, 10);
    }
  });

  it('truncates a prefix - a narrower arm keeps the leading components, renormalized', () => {
    const eight = deriveArm(fixture, 8).chunks[0].vector;
    const prefix = fixture.chunks[0].vector.slice(0, 8);
    const scale = norm(prefix);
    expect(eight.map(x => +(x * scale).toFixed(6))).toEqual(prefix);
  });

  it('refuses to widen past the capture width', () => {
    expect(() => deriveArm(fixture, 32)).toThrow(/only goes narrower/);
  });

  it('carries the capture exclusion counters through, so an arm cannot hide what it never saw', () => {
    const arm = deriveArm(fixture, 8);
    expect(arm.filesInScope).toBe(7);
    expect(arm.chunksExcluded).toBe(2);
    expect(arm.filesExcluded).toBe(1);
    expect(arm.filesUnreachable).toBe(3);
  });

  it('refuses to narrow a non-Matryoshka capture, whose prefix is not an embedding', () => {
    const ada = loadEmbeddingFixture(base({ model: 'text-embedding-ada-002' }));
    expect(() => deriveArm(ada, 2)).toThrow(/not a Matryoshka model/);
    // Its own capture width is still a legitimate arm.
    expect(deriveArm(ada, 4).arm).toBe('text-embedding-ada-002@4');
  });
});

describe('isTruncatableModel', () => {
  it('admits only the Matryoshka models the registry ships', () => {
    expect(isTruncatableModel({ model: 'text-embedding-3-small' })).toBe(true);
    expect(isTruncatableModel({ model: 'text-embedding-3-large' })).toBe(true);
  });

  it('refuses the pre-MRL and non-OpenAI embedders', () => {
    expect(isTruncatableModel({ model: 'text-embedding-ada-002' })).toBe(false);
    expect(isTruncatableModel({ model: 'voyage-3-large' })).toBe(false);
    expect(isTruncatableModel({ model: 'nomic-embed-text' })).toBe(false);
  });

  it('admits an unregistered model only when the fixture declares itself synthetic', () => {
    expect(isTruncatableModel({ model: 'synthetic-eval-embedding', syntheticMatryoshka: true })).toBe(true);
    expect(isTruncatableModel({ model: 'synthetic-eval-embedding' })).toBe(false);
  });

  it("refuses a typo'd model id, which the old registry-miss rule made truncatable", () => {
    // model-comparison.ts parses a fixture FILE, and the schema validates `model` as a non-empty
    // string - so a hand-edited typo used to render width arms of a model that never had them.
    expect(isTruncatableModel({ model: 'text-embedding-ada-oo2' })).toBe(false);
  });

  it('does not let the synthetic flag promote a model the registry knows is not Matryoshka', () => {
    expect(isTruncatableModel({ model: 'text-embedding-ada-002', syntheticMatryoshka: true })).toBe(false);
  });
});

describe('question-text integrity', () => {
  it('accepts a capture whose query hashes match the current PROBE_QUESTIONS', () => {
    expect(() => loadEmbeddingFixture(tinyFixture)).not.toThrow();
  });

  it('throws when a query vector embeds a question text corpus.ts no longer asks', () => {
    // The id set is identical, so assertSameQuerySet passes: the two arms are simply scored on
    // different questions under one label.
    const reworded = {
      ...tinyFixture,
      queries: tinyFixture.queries.map((q, i) => (i === 0 ? { ...q, questionHash: hashQuestionText('reworded') } : q)),
    };
    expect(() => loadEmbeddingFixture(reworded)).toThrow(/no longer what corpus.ts asks/);
    expect(() => loadEmbeddingFixture(reworded)).toThrow(/q01/);
  });

  it('requires the hash rather than treating its absence as agreement', () => {
    const { questionHash: _drop, ...noHash } = tinyFixture.queries[0];
    expect(() =>
      loadEmbeddingFixture({ ...tinyFixture, queries: [noHash, ...tinyFixture.queries.slice(1)] })
    ).toThrow();
  });

  it('leaves an id corpus.ts does not know to resolveQueries, which names it', () => {
    const unknown = {
      ...tinyFixture,
      queries: [...tinyFixture.queries, { id: 'q99', vector: tinyFixture.queries[0].vector, questionHash: 'deadbeef' }],
    };
    expect(() => loadEmbeddingFixture(unknown)).not.toThrow();
  });
});

describe('corpusRegime', () => {
  const chunks = [
    { docId: 'a', charLength: 100 },
    { docId: 'a', charLength: 200 },
    { docId: 'b', charLength: 300 },
    { docId: 'b', charLength: 4000 },
  ];

  it('reports the char-length distribution and chunks per file', () => {
    const r = corpusRegime(chunks);
    expect(r.files).toBe(2);
    expect(r.chunks).toBe(4);
    expect(r.chunksPerFile).toBe(2);
    expect(r.minChars).toBe(100);
    expect(r.maxChars).toBe(4000);
  });

  it('reports a percentile a real chunk actually has, not an interpolated one', () => {
    const r = corpusRegime(chunks);
    expect([100, 200, 300, 4000]).toContain(r.medianChars);
    expect([100, 200, 300, 4000]).toContain(r.p90Chars);
    expect(r.medianChars).toBe(200);
    expect(r.p90Chars).toBe(4000);
  });

  it('prefers an explicit file count over the distinct docIds present', () => {
    // Files whose chunks were all excluded still counted as in scope for the capture.
    expect(corpusRegime(chunks, 9).files).toBe(9);
  });

  it('is all zeros on an empty corpus rather than dividing by zero', () => {
    expect(corpusRegime([])).toMatchObject({ chunks: 0, chunksPerFile: 0, medianChars: 0 });
  });
});

describe('isLongDocumentRegime', () => {
  const regimeOf = (median: number) => corpusRegime([{ docId: 'a', charLength: median }]);

  it('passes a corpus in the prod passage regime', () => {
    expect(isLongDocumentRegime(regimeOf(PROD_REGIME_REFERENCE.medianChars))).toBe(true);
  });

  it('fails a corpus of short facts - the regime this ticket exists to stop inheriting', () => {
    expect(isLongDocumentRegime(regimeOf(180))).toBe(false);
  });

  it('says so in the rendered summary, not only in the boolean', () => {
    expect(formatCorpusRegime(regimeOf(180))).toContain('does not answer the question');
    expect(formatCorpusRegime(regimeOf(2200))).toContain('long-document regime : yes');
  });

  it('reads the committed synthetic fixture as in-regime', () => {
    const fixture = loadEmbeddingFixture(tinyFixture);
    expect(isLongDocumentRegime(corpusRegime(fixture.chunks, fixture.filesInScope))).toBe(true);
  });
});

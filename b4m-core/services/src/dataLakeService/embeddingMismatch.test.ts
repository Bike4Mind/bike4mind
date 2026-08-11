import { describe, expect, it } from 'vitest';
import {
  classifyAnnHit,
  classifyLoadedChunk,
  createEmbeddingMismatchAccumulator,
  describeEmbeddingMismatch,
  emptyEmbeddingMismatchReport,
  groupFilesByEmbeddingModel,
  isForeignEmbeddingModel,
  partitionFilesByEmbeddingModel,
  resolveMajorityEmbeddingModel,
} from './embeddingMismatch';

const ADA = 'text-embedding-ada-002';
const SMALL_3 = 'text-embedding-3-small';

describe('isForeignEmbeddingModel', () => {
  // The whole legacy corpus rests on these: FabFile.embeddingModel is required:false with no
  // default, so "unknown" must never read as "foreign".
  it.each([[undefined], [null], [''], ['   ']])('treats an absent label (%s) as not foreign', label => {
    expect(isForeignEmbeddingModel(label as string | null | undefined, SMALL_3)).toBe(false);
  });

  it('is not foreign when the labels match', () => {
    expect(isForeignEmbeddingModel(ADA, ADA)).toBe(false);
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(isForeignEmbeddingModel(`  ${ADA}  `, ADA)).toBe(false);
    expect(isForeignEmbeddingModel(ADA, `  ${ADA}  `)).toBe(false);
  });

  it('is foreign for a different label at the SAME vector width', () => {
    // ada-002 and 3-small are both 1536 dims, so only the label can tell them apart.
    expect(isForeignEmbeddingModel(SMALL_3, ADA)).toBe(true);
  });
});

describe('classifyLoadedChunk', () => {
  const q = { queryDim: 3, queryModel: ADA };

  it('scores a chunk whose label and width both agree', () => {
    expect(classifyLoadedChunk({ ...q, vector: [1, 2, 3], parentFile: { embeddingModel: ADA } })).toBeNull();
  });

  it('scores an unlabeled parent at the right width', () => {
    expect(classifyLoadedChunk({ ...q, vector: [1, 2, 3], parentFile: {} })).toBeNull();
  });

  it('reports a missing parent as unknownFile, before any model check', () => {
    expect(classifyLoadedChunk({ ...q, vector: [1, 2, 3], parentFile: undefined })).toBe('unknownFile');
  });

  it('prefers modelMismatch over dimensionMismatch when a chunk trips both', () => {
    // The foreign model names what to re-embed; the width alone only says they differ.
    expect(classifyLoadedChunk({ ...q, vector: [1, 2], parentFile: { embeddingModel: SMALL_3 } })).toBe(
      'modelMismatch'
    );
  });

  it.each([[null], [undefined], [[]]])('reports an empty vector (%s) as missingVector, not a width mismatch', vec => {
    expect(classifyLoadedChunk({ ...q, vector: vec as number[] | null | undefined, parentFile: {} })).toBe(
      'missingVector'
    );
  });

  it('reports a width mismatch when the label agrees', () => {
    expect(classifyLoadedChunk({ ...q, vector: [1, 2], parentFile: { embeddingModel: ADA } })).toBe(
      'dimensionMismatch'
    );
  });
});

describe('classifyAnnHit', () => {
  it('includes a hit whose parent file is still in scope', () => {
    expect(classifyAnnHit({ parentFile: { embeddingModel: ADA } })).toBeNull();
  });

  it('reports a hit for a file no longer in scope as unknownFile', () => {
    expect(classifyAnnHit({ parentFile: undefined })).toBe('unknownFile');
  });
});

describe('partitionFilesByEmbeddingModel', () => {
  it('keeps unlabeled and matching files rankable, foreign-labeled ones aside', () => {
    const { rankable, foreign } = partitionFilesByEmbeddingModel(
      [
        { id: 'legacy' },
        { id: 'match', embeddingModel: ADA },
        { id: 'foreign', embeddingModel: SMALL_3 },
        { id: 'blank', embeddingModel: '  ' },
      ],
      ADA
    );
    expect(rankable.map(f => f.id)).toEqual(['legacy', 'match', 'blank']);
    expect(foreign.map(f => f.id)).toEqual(['foreign']);
  });
});

describe('groupFilesByEmbeddingModel', () => {
  const VOYAGE_3 = 'voyage-3';

  it('groups unlabeled, blank, and query-model files as primary, matching partitionFilesByEmbeddingModel', () => {
    const files = [
      { id: 'legacy' },
      { id: 'match', embeddingModel: ADA },
      { id: 'foreign-small', embeddingModel: SMALL_3 },
      { id: 'blank', embeddingModel: '  ' },
      { id: 'foreign-voyage', embeddingModel: VOYAGE_3 },
    ];
    const groups = groupFilesByEmbeddingModel(files, ADA);
    expect(groups.primary.map(f => f.id)).toEqual(['legacy', 'match', 'blank']);
    // Anti-drift: `primary` must stay byte-identical to partitionFilesByEmbeddingModel's `rankable`
    // on the same input, so a future refactor cannot silently widen or narrow either function.
    expect(groups.primary).toEqual(partitionFilesByEmbeddingModel(files, ADA).rankable);
  });

  it('buckets each distinct foreign label separately, in first-appearance order, preserving input order within a bucket', () => {
    const groups = groupFilesByEmbeddingModel(
      [
        { id: 'v1', embeddingModel: VOYAGE_3 },
        { id: 's1', embeddingModel: SMALL_3 },
        { id: 'v2', embeddingModel: VOYAGE_3 },
        { id: 's2', embeddingModel: SMALL_3 },
      ],
      ADA
    );
    expect(groups.alternates.map(b => b.model)).toEqual([VOYAGE_3, SMALL_3]);
    expect(groups.alternates.find(b => b.model === VOYAGE_3)?.files.map(f => f.id)).toEqual(['v1', 'v2']);
    expect(groups.alternates.find(b => b.model === SMALL_3)?.files.map(f => f.id)).toEqual(['s1', 's2']);
  });

  it('collapses labels differing only in surrounding whitespace into one bucket', () => {
    const groups = groupFilesByEmbeddingModel(
      [
        { id: 'a', embeddingModel: `  ${SMALL_3}` },
        { id: 'b', embeddingModel: `${SMALL_3}  ` },
      ],
      ADA
    );
    expect(groups.alternates).toHaveLength(1);
    expect(groups.alternates[0].model).toBe(SMALL_3);
    expect(groups.alternates[0].files.map(f => f.id)).toEqual(['a', 'b']);
  });

  it('gives a case variant of a real model its own separate bucket (no case folding)', () => {
    const groups = groupFilesByEmbeddingModel(
      [
        { id: 'lower', embeddingModel: SMALL_3 },
        { id: 'upper', embeddingModel: SMALL_3.toUpperCase() },
      ],
      ADA
    );
    expect(groups.alternates.map(b => b.model).sort()).toEqual([SMALL_3, SMALL_3.toUpperCase()].sort());
  });

  it('returns no alternates for an empty file set', () => {
    expect(groupFilesByEmbeddingModel([], ADA)).toEqual({ primary: [], alternates: [] });
  });
});

describe('resolveMajorityEmbeddingModel', () => {
  it('lets an unlabeled majority outvote a single labeled outlier', () => {
    // The case that would otherwise withhold an entire legacy corpus: one re-vectorized file
    // must not decide the query model for 900 files it does not represent.
    const files = [...Array(900)].map((_, i) => ({ id: `legacy-${i}` }));
    files.push({ id: 'newcomer', embeddingModel: 'voyage-3' } as (typeof files)[number]);
    expect(resolveMajorityEmbeddingModel(files, ADA)).toBe(ADA);
  });

  it('picks a labeled majority over the fallback', () => {
    const files = [{ id: 'a', embeddingModel: SMALL_3 }, { id: 'b', embeddingModel: SMALL_3 }, { id: 'c' }];
    expect(resolveMajorityEmbeddingModel(files, ADA)).toBe(SMALL_3);
  });

  it('returns the fallback for an empty file set', () => {
    expect(resolveMajorityEmbeddingModel([], ADA)).toBe(ADA);
  });

  it('votes unlabeled files for the CALLER fallback, never a fixed cloud model', () => {
    // A caller whose only credential is a local embedder must not be handed ada-002: building
    // that service throws, and the callers swallow the throw into an empty result.
    expect(resolveMajorityEmbeddingModel([{ id: 'legacy' }], 'qwen3-embedding:0.6b')).toBe('qwen3-embedding:0.6b');
    // A labeled minority still cannot outvote them.
    expect(
      resolveMajorityEmbeddingModel(
        [{ id: 'l1' }, { id: 'l2' }, { id: 'newcomer', embeddingModel: SMALL_3 }],
        'qwen3-embedding:0.6b'
      )
    ).toBe('qwen3-embedding:0.6b');
  });

  it('never returns an unrecognized label, even when it is the most common one', () => {
    // A corrupt label reaching createEmbeddingService throws, and the callers swallow that into
    // an empty result - the silent partial this module exists to remove. Counted as unlabeled, so
    // these two vote for the fallback rather than for themselves.
    expect(
      resolveMajorityEmbeddingModel(
        [
          { id: 'a', embeddingModel: 'not-a-real-model' },
          { id: 'b', embeddingModel: 'not-a-real-model' },
          { id: 'c', embeddingModel: SMALL_3 },
        ],
        ADA
      )
    ).toBe(ADA);
  });

  it('still lets a real labeled majority win past a corrupt label', () => {
    expect(
      resolveMajorityEmbeddingModel(
        [
          { id: 'a', embeddingModel: 'not-a-real-model' },
          { id: 'b', embeddingModel: SMALL_3 },
          { id: 'c', embeddingModel: SMALL_3 },
        ],
        ADA
      )
    ).toBe(SMALL_3);
  });

  it('breaks a tie on first-seen', () => {
    expect(
      resolveMajorityEmbeddingModel(
        [
          { id: 'a', embeddingModel: SMALL_3 },
          { id: 'b', embeddingModel: 'voyage-3' },
        ],
        ADA
      )
    ).toBe(SMALL_3);
  });
});

describe('createEmbeddingMismatchAccumulator', () => {
  it('reports nothing withheld for a clean search', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.scored({ embeddingModel: ADA }, 'f1');
    const report = acc.report();
    expect(report).toEqual(emptyEmbeddingMismatchReport());
    expect(report.partial).toBe(false);
    expect(describeEmbeddingMismatch(report, ADA)).toBeNull();
  });

  it('summarises file-level exclusions from metadata, capping the sample', () => {
    const foreign = [...Array(7)].map((_, i) => ({
      id: `f${i}`,
      fileName: `file-${i}.md`,
      embeddingModel: SMALL_3,
      vectorizedChunkCount: 10,
    }));
    const report = createEmbeddingMismatchAccumulator(foreign, ADA).report();
    expect(report.excludedFiles.count).toBe(7);
    expect(report.excludedFiles.models).toEqual([SMALL_3]);
    expect(report.excludedFiles.estimatedChunks).toBe(70);
    expect(report.excludedFiles.sample).toHaveLength(5);
    expect(report.partial).toBe(true);
  });

  it('sorts and dedupes the distinct foreign models', () => {
    const report = createEmbeddingMismatchAccumulator(
      [
        { id: 'a', embeddingModel: 'voyage-3', vectorizedChunkCount: 1 },
        { id: 'b', embeddingModel: SMALL_3, vectorizedChunkCount: 1 },
        { id: 'c', embeddingModel: 'voyage-3', vectorizedChunkCount: 1 },
      ],
      ADA
    ).report();
    expect(report.excludedFiles.models).toEqual([SMALL_3, 'voyage-3']);
  });

  it('counts skips per reason and keeps a running total', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.skip('dimensionMismatch');
    acc.skip('dimensionMismatch');
    acc.skip('unknownFile');
    const report = acc.report();
    expect(report.skippedChunks.total).toBe(3);
    // Prose, not raw enum keys - this text is read by users and by the model.
    expect(describeEmbeddingMismatch(report, ADA)).toContain('2 of a different vector size');
    expect(report.skippedChunks.byReason).toEqual({
      dimensionMismatch: 2,
      unknownFile: 1,
      modelMismatch: 0,
      missingVector: 0,
    });
    expect(report.partial).toBe(true);
  });

  it('counts unlabeled scored chunks and their distinct files, but never as skips', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.scored({}, 'legacy-1');
    acc.scored({ embeddingModel: '  ' }, 'legacy-1');
    acc.scored({}, 'legacy-2');
    acc.scored({ embeddingModel: ADA }, 'labeled');
    const report = acc.report();
    expect(report.unlabeled).toEqual({ chunks: 3, files: 2 });
    expect(report.skippedChunks.total).toBe(0);
    // Unlabeled chunks were included, so on their own they do not make the result partial.
    expect(report.partial).toBe(false);
  });

  it('does not count a foreign file that chunked but never finished vectorizing', () => {
    // The state the pipeline actually writes: chunk.ts stamps vectorized = chunks.length > 0,
    // vectorizedChunkCount = 0 AND embeddingModel together at chunk time, before any vector
    // exists. Keying the guard on `vectorized` therefore reported "1 file (about 0 chunks)
    // excluded - re-embed those files" on every search after an admin model switch.
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: SMALL_3, vectorizedChunkCount: 0 }],
      ADA
    );
    const report = acc.report();
    expect(report.excludedFiles.count).toBe(0);
    expect(report.partial).toBe(false);
    expect(describeEmbeddingMismatch(report, ADA)).toBeNull();
  });

  it('does not let a never-embedded chunk make the result partial', () => {
    // A chunk with no vector was never embedded, which is not an embedding-space mismatch. Some
    // are permanently unembeddable (oversized past the context window), so counting them would
    // flag that lake on every turn forever with no remedy the user can apply.
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.skip('missingVector');
    acc.skip('unknownFile');
    const report = acc.report();
    expect(report.skippedChunks.total).toBe(2);
    expect(report.partial).toBe(false);
    expect(describeEmbeddingMismatch(report, ADA)).toBeNull();
  });

  it('still goes partial for a real embedding-space mismatch', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.skip('dimensionMismatch');
    expect(acc.report().partial).toBe(true);
    const acc2 = createEmbeddingMismatchAccumulator([], ADA);
    acc2.skip('modelMismatch');
    expect(acc2.report().partial).toBe(true);
  });

  it('does not count a foreign file that holds no vectors', () => {
    // Chunked under a previous default but its vectorize job never finished: excluding it
    // withheld nothing, so claiming a partial result would be false.
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: SMALL_3, vectorized: false, vectorizedChunkCount: 0 }],
      ADA
    );
    expect(acc.report().excludedFiles.count).toBe(0);
    expect(acc.report().partial).toBe(false);
  });

  describe('alternateModelServed', () => {
    it('starts zeroed on a fresh report', () => {
      expect(emptyEmbeddingMismatchReport().alternateModelServed).toEqual({ files: 0, models: [] });
    });

    it('records served files/models without touching partial', () => {
      const acc = createEmbeddingMismatchAccumulator([], ADA);
      acc.alternateModelServed(3, ['voyage-3']);
      const report = acc.report();
      expect(report.alternateModelServed).toEqual({ files: 3, models: ['voyage-3'] });
      expect(report.partial).toBe(false);
    });

    it('accumulates across multiple calls and sorts/dedupes models', () => {
      const acc = createEmbeddingMismatchAccumulator([], ADA);
      acc.alternateModelServed(2, [SMALL_3]);
      acc.alternateModelServed(1, ['voyage-3']);
      acc.alternateModelServed(1, [SMALL_3]);
      const report = acc.report();
      expect(report.alternateModelServed).toEqual({ files: 4, models: [SMALL_3, 'voyage-3'] });
    });

    it('does not flip partial to true even when combined with a genuine exclusion elsewhere', () => {
      const acc = createEmbeddingMismatchAccumulator(
        [{ id: 'a', embeddingModel: 'voyage-3', vectorizedChunkCount: 1 }],
        ADA
      );
      // Served comes from a DIFFERENT alternate model than the one still excluded.
      acc.alternateModelServed(2, [SMALL_3]);
      const report = acc.report();
      expect(report.partial).toBe(true); // from the excluded voyage-3 file, not from being served
      expect(report.alternateModelServed).toEqual({ files: 2, models: [SMALL_3] });
    });
  });
});

describe('describeEmbeddingMismatch', () => {
  it('names the embedder as the cause, not a mismatch, when the query could not be embedded', () => {
    // Otherwise the text reads as a normal search with exclusions and sends the reader off to
    // re-embed files when the embedder is what failed.
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: SMALL_3, vectorizedChunkCount: 1 }],
      ADA
    );
    acc.queryEmbeddingFailed();
    const report = acc.report();
    expect(report.queryEmbeddingFailed).toBe(true);
    expect(report.partial).toBe(true);
    const text = describeEmbeddingMismatch(report, ADA);
    expect(text).toContain('could not be embedded');
    expect(text).not.toContain('Re-embed');
  });

  it('names both models and the remedy', () => {
    const report = createEmbeddingMismatchAccumulator(
      [{ id: 'a', fileName: 'a.md', embeddingModel: SMALL_3, vectorizedChunkCount: 4 }],
      ADA
    ).report();
    const text = describeEmbeddingMismatch(report, ADA);
    expect(text).toContain(SMALL_3);
    expect(text).toContain(ADA);
    expect(text).toContain('about 4 chunks');
    expect(text).toContain('Re-embed');
  });

  it('stays silent for an unlabeled-but-included corpus', () => {
    // Most legacy lakes are entirely unlabeled. Those chunks WERE searched, so calling that a
    // partial result would warn on nearly every search and train the reader to ignore it.
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.scored({}, 'legacy');
    expect(describeEmbeddingMismatch(acc.report(), ADA)).toBeNull();
  });

  it('mentions unlabeled chunks once there IS a genuine withholding to explain', () => {
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: SMALL_3, vectorizedChunkCount: 1 }],
      ADA
    );
    acc.scored({}, 'legacy');
    const text = describeEmbeddingMismatch(acc.report(), ADA);
    expect(text).toContain('unverified');
    expect(text).toContain(SMALL_3);
  });

  it('returns null for a missing report rather than throwing', () => {
    expect(describeEmbeddingMismatch(undefined, ADA)).toBeNull();
  });

  it('mentions alternate-model-served files only alongside a genuine withholding', () => {
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: 'voyage-3', vectorizedChunkCount: 1 }],
      ADA
    );
    acc.alternateModelServed(2, [SMALL_3]);
    const text = describeEmbeddingMismatch(acc.report(), ADA);
    expect(text).toContain('2 file(s) embedded with');
    expect(text).toContain(SMALL_3);
    expect(text).toContain('searched through their own vector index');
    // The exclusion sentence about voyage-3 is still present too - served and excluded coexist.
    expect(text).toContain('voyage-3');
  });

  it('stays silent (null) when the only thing to report is alternate-model coverage, nothing withheld', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.alternateModelServed(5, [SMALL_3]);
    expect(acc.report().partial).toBe(false);
    expect(describeEmbeddingMismatch(acc.report(), ADA)).toBeNull();
  });
});

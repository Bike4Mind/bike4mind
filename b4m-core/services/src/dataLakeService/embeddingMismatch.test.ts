import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  classifyLoadedChunk,
  createEmbeddingMismatchAccumulator,
  describeEmbeddingMismatch,
  emptyEmbeddingMismatchReport,
  isForeignEmbeddingModel,
  partitionFilesByEmbeddingModel,
  resolveMajorityEmbeddingModel,
  totalWithheldChunks,
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

describe('resolveMajorityEmbeddingModel', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lets an unlabeled majority outvote a single labeled outlier', () => {
    // The case that would otherwise withhold an entire legacy corpus: one re-vectorized file
    // must not decide the query model for 900 files it does not represent.
    const files = [...Array(900)].map((_, i) => ({ id: `legacy-${i}` }));
    files.push({ id: 'newcomer', embeddingModel: 'voyage-3' } as (typeof files)[number]);
    expect(resolveMajorityEmbeddingModel(files)).toBe(ADA);
  });

  it('picks a labeled majority over the deployment default', () => {
    const files = [{ id: 'a', embeddingModel: SMALL_3 }, { id: 'b', embeddingModel: SMALL_3 }, { id: 'c' }];
    expect(resolveMajorityEmbeddingModel(files)).toBe(SMALL_3);
  });

  it('falls back to the deployment default for an empty file set', () => {
    expect(resolveMajorityEmbeddingModel([])).toBe(ADA);
  });

  it('votes unlabeled files for the local embedder on keyless self-host', () => {
    // defaultEmbeddingModelForEnv resolves to Ollama there, so unlabeled files must not be
    // guessed as a cloud model that never embedded them.
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('VOYAGE_API_KEY', '');
    expect(resolveMajorityEmbeddingModel([{ id: 'legacy' }])).toBe('qwen3-embedding:0.6b');
  });

  it('breaks a tie on first-seen', () => {
    expect(
      resolveMajorityEmbeddingModel([
        { id: 'a', embeddingModel: SMALL_3 },
        { id: 'b', embeddingModel: 'voyage-3' },
      ])
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
        { id: 'a', embeddingModel: 'voyage-3' },
        { id: 'b', embeddingModel: SMALL_3 },
        { id: 'c', embeddingModel: 'voyage-3' },
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

  it('marks a capped corpus partial even with zero mismatches', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.truncation({ chunkCapHit: true, filesTotal: 4321 });
    const report = acc.report();
    expect(report.partial).toBe(true);
    expect(describeEmbeddingMismatch(report, ADA)).toContain('cap');
  });

  it('adds both provenances for a total withheld count', () => {
    const acc = createEmbeddingMismatchAccumulator(
      [{ id: 'a', embeddingModel: SMALL_3, vectorizedChunkCount: 12 }],
      ADA
    );
    acc.skip('dimensionMismatch');
    expect(totalWithheldChunks(acc.report())).toBe(13);
  });
});

describe('describeEmbeddingMismatch', () => {
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

  it('flags unlabeled chunks as unverified even when nothing was withheld', () => {
    const acc = createEmbeddingMismatchAccumulator([], ADA);
    acc.scored({}, 'legacy');
    expect(describeEmbeddingMismatch(acc.report(), ADA)).toContain('unverified');
  });

  it('returns null for a missing report rather than throwing', () => {
    expect(describeEmbeddingMismatch(undefined, ADA)).toBeNull();
  });
});

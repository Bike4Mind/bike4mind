import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGenerateEmbedding, mockCreateEmbeddingService } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(async () => [1, 0]),
  mockCreateEmbeddingService: vi.fn(() => ({ generateEmbedding: mockGenerateEmbedding })),
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: (m: string) => (m.startsWith('voyage-') ? 'voyageai' : 'openai'),
    EmbeddingFactory: class {
      createEmbeddingService(model: string) {
        return mockCreateEmbeddingService(model);
      }
    },
  };
});

import {
  MAX_ALTERNATE_ANN_MODELS,
  planAlternateAnnModels,
  runAlternateModelAnn,
  tryEmbedQueryForModel,
} from './alternateModelAnn';

const ADA = 'text-embedding-ada-002';
const SMALL_3 = 'text-embedding-3-small';
const VOYAGE_3 = 'voyage-3';
const now = new Date();
const readyStamp = new Date(now.getTime() - 120_000);
const freshStamp = new Date(now.getTime() - 10_000);

const file = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  vectorizedChunkCount: 1,
  chunkEmbeddingModelStampedAt: readyStamp,
  ...overrides,
});

beforeEach(() => {
  mockGenerateEmbedding.mockReset().mockResolvedValue([1, 0]);
  mockCreateEmbeddingService.mockClear();
});

describe('planAlternateAnnModels', () => {
  it('never calls isModelQueryable when there are zero alternates', async () => {
    const isModelQueryable = vi.fn();
    const plan = await planAlternateAnnModels({
      alternates: [],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable,
    });
    expect(plan).toEqual({ selected: [], skipped: [] });
    expect(isModelQueryable).not.toHaveBeenCalled();
  });

  it('skips an unrecognized model without ever probing or embedding it', async () => {
    const isModelQueryable = vi.fn();
    const plan = await planAlternateAnnModels({
      alternates: [{ model: 'not-a-real-model', files: [file('a')] }],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable,
    });
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([{ model: 'not-a-real-model', files: [file('a')], reason: 'unsupportedModel' }]);
    expect(isModelQueryable).not.toHaveBeenCalled();
  });

  it('skips a bucket with no vectorized files', async () => {
    const isModelQueryable = vi.fn();
    const plan = await planAlternateAnnModels({
      alternates: [{ model: SMALL_3, files: [file('a', { vectorizedChunkCount: 0 })] }],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable,
    });
    expect(plan.skipped).toEqual([
      { model: SMALL_3, files: [file('a', { vectorizedChunkCount: 0 })], reason: 'notVectorized' },
    ]);
    expect(isModelQueryable).not.toHaveBeenCalled();
  });

  it('excludes not-yet-ANN-ready files without scanning them, and drops the bucket if none are ready', async () => {
    const isModelQueryable = vi.fn();
    const plan = await planAlternateAnnModels({
      alternates: [{ model: SMALL_3, files: [file('fresh', { chunkEmbeddingModelStampedAt: freshStamp })] }],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable,
    });
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([
      { model: SMALL_3, files: [file('fresh', { chunkEmbeddingModelStampedAt: freshStamp })], reason: 'notAnnReady' },
    ]);
    expect(isModelQueryable).not.toHaveBeenCalled();
  });

  it('skips a model whose provider has no credential in the caller key table, before probing the index', async () => {
    const isModelQueryable = vi.fn();
    const plan = await planAlternateAnnModels({
      alternates: [{ model: VOYAGE_3, files: [file('a')] }],
      now,
      apiKeyTable: { openai: 'k' }, // no voyageai key
      isModelQueryable,
    });
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([{ model: VOYAGE_3, files: [file('a')], reason: 'missingCredential' }]);
    expect(isModelQueryable).not.toHaveBeenCalled();
  });

  it('skips a model with no queryable index', async () => {
    const plan = await planAlternateAnnModels({
      alternates: [{ model: SMALL_3, files: [file('a')] }],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable: async () => false,
    });
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([{ model: SMALL_3, files: [file('a')], reason: 'noQueryableIndex' }]);
  });

  it('treats a rejecting isModelQueryable as not-queryable, without affecting other models', async () => {
    const plan = await planAlternateAnnModels({
      alternates: [
        { model: SMALL_3, files: [file('a')] },
        { model: VOYAGE_3, files: [file('b')] },
      ],
      now,
      apiKeyTable: { openai: 'k', voyageai: 'k2' },
      isModelQueryable: async (m: string) => {
        if (m === SMALL_3) throw new Error('mongot down');
        return true;
      },
    });
    expect(plan.selected.map(s => s.model)).toEqual([VOYAGE_3]);
    expect(plan.skipped).toContainEqual({ model: SMALL_3, files: [file('a')], reason: 'noQueryableIndex' });
  });

  it('selects only ANN-ready files from a mixed bucket, recording the fresh ones as notAnnReady', async () => {
    const plan = await planAlternateAnnModels({
      alternates: [
        { model: SMALL_3, files: [file('ready'), file('fresh', { chunkEmbeddingModelStampedAt: freshStamp })] },
      ],
      now,
      apiKeyTable: { openai: 'k' },
      isModelQueryable: async () => true,
    });
    expect(plan.selected).toEqual([{ model: SMALL_3, annReady: [file('ready')] }]);
    expect(plan.skipped).toContainEqual({
      model: SMALL_3,
      files: [file('fresh', { chunkEmbeddingModelStampedAt: freshStamp })],
      reason: 'notAnnReady',
    });
  });

  it('caps real registered models at MAX_ALTERNATE_ANN_MODELS, ranked by coverage then name', async () => {
    const models = [ADA, SMALL_3, VOYAGE_3, 'text-embedding-3-large'];
    const alternates = models.map((model, i) => ({
      model,
      files: Array.from({ length: i + 1 }, (_, j) => file(`${model}-${j}`)),
    }));
    const plan = await planAlternateAnnModels({
      alternates,
      now,
      apiKeyTable: { openai: 'k', voyageai: 'k2' },
      isModelQueryable: async () => true,
    });
    expect(plan.selected).toHaveLength(MAX_ALTERNATE_ANN_MODELS);
    // Highest coverage first: text-embedding-3-large (4 files) > voyage-3 (3) > text-embedding-3-small (2).
    expect(plan.selected.map(s => s.model)).toEqual(['text-embedding-3-large', VOYAGE_3, SMALL_3]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({ model: ADA, reason: 'overModelCap' }));
  });

  it('resolves a coverage tie by model name ascending', async () => {
    const models = ['text-embedding-3-large', SMALL_3, VOYAGE_3, ADA];
    const alternates = models.map(model => ({ model, files: [file(`${model}-0`)] })); // all coverage = 1
    const plan = await planAlternateAnnModels({
      alternates,
      now,
      apiKeyTable: { openai: 'k', voyageai: 'k2' },
      isModelQueryable: async () => true,
      cap: 2,
    });
    // Lexicographic ascending: 'text-embedding-3-large' < 'text-embedding-3-small' < 'text-embedding-ada-002' < 'voyage-3'.
    expect(plan.selected.map(s => s.model)).toEqual(['text-embedding-3-large', SMALL_3]);
  });
});

describe('tryEmbedQueryForModel', () => {
  it('returns the embedded vector on the happy path', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2]);
    const vector = await tryEmbedQueryForModel({ query: 'q', model: SMALL_3, apiKeyTable: { openai: 'k' } });
    expect(vector).toEqual([0.1, 0.2]);
    expect(mockCreateEmbeddingService).toHaveBeenCalledWith(SMALL_3);
  });

  it('returns null (never throws) when the provider credential is missing', async () => {
    const vector = await tryEmbedQueryForModel({ query: 'q', model: VOYAGE_3, apiKeyTable: { openai: 'k' } });
    expect(vector).toBeNull();
    expect(mockCreateEmbeddingService).not.toHaveBeenCalled();
  });

  it('returns null when the embedding factory throws', async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new Error('provider outage'));
    const vector = await tryEmbedQueryForModel({ query: 'q', model: SMALL_3, apiKeyTable: { openai: 'k' } });
    expect(vector).toBeNull();
  });

  it('returns null for an empty embedding vector', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([]);
    const vector = await tryEmbedQueryForModel({ query: 'q', model: SMALL_3, apiKeyTable: { openai: 'k' } });
    expect(vector).toBeNull();
  });
});

describe('runAlternateModelAnn', () => {
  const candidate = { model: SMALL_3, annReady: [{ id: 'a' }, { id: 'b' }] };

  it('embeds and queries under the ALTERNATE model, not any primary model, passing only annReady ids', async () => {
    const runAnn = vi.fn().mockResolvedValue({
      results: [{ chunkId: 'c1', fileId: 'a', fileName: 'a.pdf', fileTags: [], chunkText: 't', score: 0.5 }],
      hitsReturned: 1,
      hitsSkippedUnknownFile: 0,
      filesWithHits: new Set(['a']),
    });
    const outcome = await runAlternateModelAnn({
      query: 'q',
      candidate,
      apiKeyTable: { openai: 'k' },
      runAnn,
    });
    expect(mockCreateEmbeddingService).toHaveBeenCalledWith(SMALL_3);
    expect(runAnn).toHaveBeenCalledWith({ fileIds: ['a', 'b'], queryVector: [1, 0], model: SMALL_3 });
    expect(outcome.embedded).toBe(true);
    expect(outcome.failed).toBe(false);
    expect(outcome.filesWithHits).toEqual(new Set(['a']));
    expect(outcome.filesMissed).toEqual(['b']);
  });

  it('populates filesMissed and leaves filesWithHits empty on zero raw hits', async () => {
    const runAnn = vi
      .fn()
      .mockResolvedValue({ results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() });
    const outcome = await runAlternateModelAnn({
      query: 'q',
      candidate,
      apiKeyTable: { openai: 'k' },
      runAnn,
    });
    expect(outcome.embedded).toBe(true);
    expect(outcome.failed).toBe(false);
    expect(outcome.filesWithHits.size).toBe(0);
    expect(outcome.filesMissed).toEqual(['a', 'b']);
  });

  it('makes no ANN call when the embed fails, and never rejects', async () => {
    const runAnn = vi.fn();
    const outcome = await runAlternateModelAnn({
      query: 'q',
      candidate: { model: VOYAGE_3, annReady: [{ id: 'a' }] },
      apiKeyTable: { openai: 'k' }, // no voyageai key -> embed fails
      runAnn,
    });
    expect(runAnn).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      model: VOYAGE_3,
      results: [],
      hitsReturned: 0,
      hitsSkippedUnknownFile: 0,
      filesWithHits: new Set(),
      filesMissed: [],
      embedded: false,
      failed: true,
    });
  });

  it('reports failed:true and warns, without rejecting, when the ANN query itself throws', async () => {
    const logger = { warn: vi.fn() };
    const runAnn = vi.fn().mockRejectedValue(new Error('index unavailable'));
    const outcome = await runAlternateModelAnn({
      query: 'q',
      candidate,
      apiKeyTable: { openai: 'k' },
      runAnn,
      logger: logger as never,
    });
    expect(outcome.embedded).toBe(true);
    expect(outcome.failed).toBe(true);
    expect(outcome.results).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[semanticSearch] alternate-model ANN query failed',
      expect.objectContaining({ model: SMALL_3 })
    );
  });
});

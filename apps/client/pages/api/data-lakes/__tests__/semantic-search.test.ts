import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => Promise<unknown>;

// The route decides the response CONTRACT, so it needs a route-level test: the service tests
// prove the report is computed, only this proves it reaches the wire (and that a healthy search
// stays byte-for-byte as quiet as before).
const { captured } = vi.hoisted(() => ({ captured: {} as { handler?: RouteHandler } }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn?: RouteHandler) => unknown> = {};
  chain.use = () => chain;
  chain.post = (fn?: RouteHandler) => {
    captured.handler = fn;
    return chain;
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: RouteHandler) => fn }));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: vi.fn().mockResolvedValue([]) }));

// The search itself is stubbed, but the report helpers are the REAL ones: the wording and the
// snake_case shape are what this test checks, so a reimplementation here would prove nothing.
// They come from source rather than importOriginal because the module is pure (it only reads the
// embedding-model enums) and pulling the whole services barrel in jsdom is not.
vi.mock('@bike4mind/services', async () => {
  // Path inlined: vi.mock is hoisted above any top-level const.
  const real = await import('../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch');
  return {
    apiKeyService: { getEffectiveApiKey: vi.fn().mockResolvedValue('k') },
    recordOperationalUsage: vi.fn().mockResolvedValue(undefined),
    dataLakeService: {
      semanticDataLakeSearch: vi.fn(),
      describeEmbeddingMismatch: real.describeEmbeddingMismatch,
      emptyEmbeddingMismatchReport: real.emptyEmbeddingMismatchReport,
    },
  };
});
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  fabFileChunkRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002') },
  creditTransactionRepository: {},
  organizationRepository: { findById: vi.fn().mockResolvedValue(null) },
  usageEventRepository: {},
  userRepository: { findById: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ getProviderFromModel: () => 'openai' }));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    createTokenizer: () => ({ countTokens: async () => 5 }),
    getSettingsByNames: vi.fn().mockResolvedValue({}),
  };
});

import { adminSettingsRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { emptyEmbeddingMismatchReport } from '../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch';
import '../semantic-search';

const searchSpy = dataLakeService.semanticDataLakeSearch as unknown as Mock;

const ADA = 'text-embedding-ada-002';
const SMALL_3 = 'text-embedding-3-small';

const searchResult = (over: Record<string, unknown> = {}) => ({
  results: [{ chunkId: 'c1', fileId: 'f1', fileName: 'a.md', fileTags: ['t'], chunkText: 'body', score: 0.81 }],
  totalChunksSearched: 3,
  filesInScope: 2,
  chunksScored: 3,
  embeddingModel: ADA,
  embeddingMismatch: emptyEmbeddingMismatchReport(),
  ...over,
});

const mismatchedReport = () => {
  const report = emptyEmbeddingMismatchReport();
  report.excludedFiles = {
    count: 1,
    models: [SMALL_3],
    estimatedChunks: 4,
    sample: [{ fileId: 'f9', fileName: 'foreign.md', embeddingModel: SMALL_3 }],
  };
  report.skippedChunks = {
    total: 2,
    byReason: { unknownFile: 0, modelMismatch: 0, missingVector: 1, dimensionMismatch: 1 },
  };
  report.partial = true;
  return report;
};

const invoke = async (body: Record<string, unknown>, user: Record<string, unknown> = {}) => {
  const json = vi.fn();
  const res = { json, status: vi.fn().mockReturnThis(), end: vi.fn(), writableEnded: false } as unknown as Response;
  const req = {
    body,
    // isAdmin short-circuits the lake gate to the full registry, which is what the reporting
    // tests want; the empty-scope test overrides it to an untagged non-admin.
    user: { id: 'u1', isAdmin: true, tags: [], groups: [], ...user },
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() },
    on: vi.fn(),
  } as unknown as Request;
  await captured.handler!(req, res);
  return { json, body: json.mock.calls[0]?.[0] };
};

describe('POST /api/data-lakes/semantic-search mismatch reporting', () => {
  beforeEach(() => {
    searchSpy.mockReset();
  });

  it('flags a partial result and explains it', async () => {
    searchSpy.mockResolvedValue(searchResult({ embeddingMismatch: mismatchedReport() }));

    const { body } = await invoke({ query: 'dosing' });

    expect(body.partial_results).toBe(true);
    expect(body.chunks_scored).toBe(3);
    expect(body.files_in_scope).toBe(2);
    expect(body.embedding_mismatch.excluded_files).toEqual({
      count: 1,
      models: [SMALL_3],
      estimated_chunks: 4,
      sample: [{ file_id: 'f9', file_name: 'foreign.md', embedding_model: SMALL_3 }],
    });
    expect(body.embedding_mismatch.skipped_chunks.by_reason).toEqual({
      unknown_file: 0,
      model_mismatch: 0,
      missing_vector: 1,
      dimension_mismatch: 1,
    });
    // The warning has to name both models for the reader to know what to re-embed.
    expect(body.warning).toContain(SMALL_3);
    expect(body.warning).toContain(ADA);
  });

  it('adds no warning key at all to a healthy search', async () => {
    searchSpy.mockResolvedValue(searchResult());

    const { body } = await invoke({ query: 'dosing' });

    expect(body.partial_results).toBe(false);
    expect('warning' in body).toBe(false);
    expect(body.embedding_mismatch.skipped_chunks.total).toBe(0);
    expect(body.embedding_mismatch.query_embedding_failed).toBe(false);
  });

  it('returns the same shape when the caller can reach no lakes', async () => {
    // This exit never calls the service, and its response is passed through verbatim to the
    // RLM agent, so a narrower object would read as a different contract.
    const { body } = await invoke({ query: 'dosing' }, { isAdmin: false });

    expect(searchSpy).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      results: [],
      total_chunks_searched: 0,
      files_in_scope: 0,
      chunks_scored: 0,
      partial_results: false,
    });
    expect(body.embedding_mismatch.skipped_chunks.by_reason.dimension_mismatch).toBe(0);
  });

  it('still forwards the caller top_k, min_score and tags', async () => {
    searchSpy.mockResolvedValue(searchResult());

    await invoke({ query: 'dosing', top_k: 3, min_score: 0.5, tags: ['acme:x'] });

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 3, minScore: 0.5, tags: ['acme:x'] }),
      expect.anything()
    );
  });

  it('rejects an invalid body before any search', async () => {
    const { body } = await invoke({ query: '' });
    expect(body.error).toBe('Invalid request body');
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/semantic-search query model', () => {
  beforeEach(() => {
    searchSpy.mockReset().mockResolvedValue(searchResult());
    (adminSettingsRepository.getSettingsValue as Mock).mockResolvedValue('text-embedding-ada-002');
  });

  it('embeds the query with the model the corpus was stamped with, not a hardcoded ada-002', async () => {
    // The chunk pipeline stamps files with the defaultEmbeddingModel admin setting. Querying a
    // non-ada deployment with ada-002 would classify its entire consistent lake as mismatched
    // and tell the operator to re-embed a corpus that is perfectly fine.
    (adminSettingsRepository.getSettingsValue as Mock).mockResolvedValue('text-embedding-3-small');

    await invoke({ query: 'dosing' });

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: 'text-embedding-3-small' }),
      expect.anything()
    );
  });

  it('still honors an explicit embedding_model from the caller', async () => {
    (adminSettingsRepository.getSettingsValue as Mock).mockResolvedValue('text-embedding-3-small');

    await invoke({ query: 'dosing', embedding_model: 'voyage-3' });

    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'voyage-3' }), expect.anything());
  });

  it('falls back to ada-002 when the setting is missing or unrecognized', async () => {
    (adminSettingsRepository.getSettingsValue as Mock).mockResolvedValue('not-a-real-model');

    await invoke({ query: 'dosing' });

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: 'text-embedding-ada-002' }),
      expect.anything()
    );
  });

  it('rejects an unknown explicit model instead of silently substituting one', async () => {
    const { body } = await invoke({ query: 'dosing', embedding_model: 'made-up' });
    expect(body.error).toBe('Invalid request body');
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

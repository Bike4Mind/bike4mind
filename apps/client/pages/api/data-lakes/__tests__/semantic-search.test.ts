import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const {
  mockResolveScope,
  mockSemanticSearch,
  mockGetEffectiveApiKey,
  mockGetEffectiveLLMApiKeys,
  mockFindUserById,
  mockGetSettingsValue,
} = vi.hoisted(() => ({
  mockResolveScope: vi.fn(),
  mockSemanticSearch: vi.fn(),
  mockGetEffectiveApiKey: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockFindUserById: vi.fn(),
  mockGetSettingsValue: vi.fn(),
}));

// Only the middleware chain and the seams below are mocked; @bike4mind/common stays real so
// the embedding-model allowlist and provider enums behave as they do in production.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: unknown, _res: unknown) => undefined }));
vi.mock('@server/dataLakes/resolveRetrievalLakeScope', () => ({ resolveRetrievalLakeScope: mockResolveScope }));
vi.mock('@bike4mind/fab-pipeline', () => ({ getProviderFromModel: () => 'openai' }));
vi.mock('@bike4mind/utils', () => ({
  createTokenizer: () => ({ countTokens: vi.fn(async () => 3) }),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  fabFileChunkRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: mockGetSettingsValue },
  creditTransactionRepository: {},
  organizationRepository: { findById: vi.fn() },
  usageEventRepository: {},
  userRepository: { findById: mockFindUserById },
}));
// The report helpers are the REAL ones: the warning wording and the snake_case mapping are part of
// what these tests check, so a reimplementation here would prove nothing. They come from source
// because the module is pure, while pulling the whole services barrel into jsdom is not.
vi.mock('@bike4mind/services', async () => {
  const real = await import('../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch');
  return {
    apiKeyService: {
      getEffectiveApiKey: mockGetEffectiveApiKey,
      getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys,
    },
    dataLakeService: {
      semanticDataLakeSearch: mockSemanticSearch,
      describeEmbeddingMismatch: real.describeEmbeddingMismatch,
      emptyEmbeddingMismatchReport: real.emptyEmbeddingMismatchReport,
    },
    recordOperationalUsage: vi.fn(),
  };
});

import handler from '@pages/api/data-lakes/semantic-search';
import { emptyEmbeddingMismatchReport } from '../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch';

const DYNAMIC_SCOPE = {
  dataLakeTags: ['datalake:acme-handbook'],
  dataLakeTagPrefixes: ['opti:'],
  scopedTagPrefixes: ['acme:'],
};

// Mirrors the real result shape. chunksScored/embeddingMismatch are required on the service's
// return type, and these mocks are untyped, so omitting them would surface only at runtime.
const EMPTY_RESULT = {
  results: [],
  totalChunksSearched: 0,
  filesInScope: 0,
  chunksScored: 0,
  embeddingModel: 'text-embedding-ada-002',
  embeddingMismatch: emptyEmbeddingMismatchReport(),
};

/** A report describing one file withheld for being embedded with another model. */
const mismatchReport = () => {
  const report = emptyEmbeddingMismatchReport();
  report.excludedFiles = {
    count: 1,
    models: ['text-embedding-3-small'],
    estimatedChunks: 4,
    sample: [{ fileId: 'f9', fileName: 'foreign.md', embeddingModel: 'text-embedding-3-small' }],
  };
  report.skippedChunks = {
    total: 2,
    byReason: { unknownFile: 0, modelMismatch: 0, missingVector: 1, dimensionMismatch: 1 },
  };
  report.partial = true;
  return report;
};

// req.on is required by the client-disconnect listener; the logger by the usage-recording catch.
const makeReq = (body: unknown, user: Record<string, unknown> = { id: 'u1', tags: [] }) =>
  ({ user, body, on: vi.fn(), logger: { warn: vi.fn(), debug: vi.fn() } }) as never;

const makeRes = () => {
  const res: Record<string, unknown> = { writableEnded: false };
  res.json = vi.fn(() => res);
  res.status = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

const searchParams = () => mockSemanticSearch.mock.calls[0][0];

describe('POST /api/data-lakes/semantic-search lake scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveScope.mockResolvedValue(DYNAMIC_SCOPE);
    mockSemanticSearch.mockResolvedValue(EMPTY_RESULT);
    mockGetEffectiveApiKey.mockResolvedValue('test-openai-key');
    mockGetSettingsValue.mockResolvedValue('text-embedding-ada-002');
    // Null user short-circuits the best-effort usage recording, keeping these tests on the
    // search path only.
    mockFindUserById.mockResolvedValue(null);
  });

  it('embeds the query with the model the corpus was vectorized with, not a hardcoded default', async () => {
    // The vectorize pipeline and the chat tool both use defaultEmbeddingModel; querying in a
    // different space returns nothing (dimension skip) or nonsense (same dim, other space).
    mockGetSettingsValue.mockResolvedValue('voyage-3-large');

    await handler(makeReq({ query: 'onboarding' }), makeRes());

    expect(searchParams().embeddingModel).toBe('voyage-3-large');
  });

  it('still honours an explicit embedding_model without reading the admin setting', async () => {
    await handler(makeReq({ query: 'onboarding', embedding_model: 'text-embedding-3-small' }), makeRes());

    expect(searchParams().embeddingModel).toBe('text-embedding-3-small');
    expect(mockGetSettingsValue).not.toHaveBeenCalled();
  });

  it('falls back to ada-002 when the admin setting is unset or no longer supported', async () => {
    mockGetSettingsValue.mockResolvedValue('some-retired-model');

    await handler(makeReq({ query: 'onboarding' }), makeRes());

    expect(searchParams().embeddingModel).toBe('text-embedding-ada-002');
  });

  it('warns when the configured model is unsupported, since the symptom is an empty result set', async () => {
    mockGetSettingsValue.mockResolvedValue('some-retired-model');
    const req = makeReq({ query: 'onboarding' });

    await handler(req, makeRes());

    expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('some-retired-model'));
  });

  it('does not warn when the setting is simply unset', async () => {
    mockGetSettingsValue.mockResolvedValue(undefined);
    const req = makeReq({ query: 'onboarding' });

    await handler(req, makeRes());

    expect(searchParams().embeddingModel).toBe('text-embedding-ada-002');
    expect(req.logger.warn).not.toHaveBeenCalled();
  });

  it('rejects an unsupported explicit embedding_model rather than silently falling back', async () => {
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding', embedding_model: 'not-a-model' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('forwards all three lake buckets to the search service verbatim', async () => {
    await handler(makeReq({ query: 'onboarding' }), makeRes());

    expect(mockSemanticSearch).toHaveBeenCalledTimes(1);
    expect(searchParams()).toMatchObject({
      dataLakeTags: DYNAMIC_SCOPE.dataLakeTags,
      dataLakeTagPrefixes: DYNAMIC_SCOPE.dataLakeTagPrefixes,
      scopedTagPrefixes: DYNAMIC_SCOPE.scopedTagPrefixes,
    });
  });

  it('forwards an EMPTY scopedTagPrefixes rather than omitting it', async () => {
    // The service defaults the field to [], so omission is invisible unless the empty case is
    // asserted for presence rather than truthiness.
    mockResolveScope.mockResolvedValue({ ...DYNAMIC_SCOPE, scopedTagPrefixes: [] });

    await handler(makeReq({ query: 'onboarding' }), makeRes());

    expect(searchParams()).toHaveProperty('scopedTagPrefixes');
    expect(searchParams().scopedTagPrefixes).toEqual([]);
  });

  it('hands the live request to the scope resolver, preserving its entitlement memo', async () => {
    const req = makeReq({ query: 'onboarding' });

    await handler(req, makeRes());

    expect(mockResolveScope).toHaveBeenCalledWith(req);
  });

  it('never lets a dynamic prefix reach the ownership-bypassing OPEN param', async () => {
    await handler(makeReq({ query: 'onboarding' }), makeRes());

    expect(searchParams().dataLakeTagPrefixes).not.toContain('acme:');
    expect(searchParams().scopedTagPrefixes).toContain('acme:');
  });

  it('proceeds when the caller holds only dynamic lakes (no open prefixes)', async () => {
    mockResolveScope.mockResolvedValue({
      dataLakeTags: ['datalake:acme-handbook'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: ['acme:'],
    });

    await handler(makeReq({ query: 'onboarding' }), makeRes());

    // Gating on prefixes instead of meta-tags would wrongly short-circuit this caller.
    expect(mockSemanticSearch).toHaveBeenCalledTimes(1);
    expect(searchParams().dataLakeTagPrefixes).toEqual([]);
  });

  it('returns an empty payload with no embedding spend when no lakes are accessible', async () => {
    mockResolveScope.mockResolvedValue({ dataLakeTags: [], dataLakeTagPrefixes: [], scopedTagPrefixes: [] });
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [],
        total_chunks_searched: 0,
        embedding_model: 'text-embedding-ada-002',
        // Same shape as a real search - the RLM tool passes this response through verbatim.
        files_in_scope: 0,
        chunks_scored: 0,
        partial_results: false,
      })
    );
    // Without these the test still passes with the short-circuit deleted.
    expect(mockGetEffectiveApiKey).not.toHaveBeenCalled();
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('rejects a malformed body before resolving any lakes', async () => {
    const res = makeRes();

    await handler(makeReq({ top_k: 5 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResolveScope).not.toHaveBeenCalled();
  });

  it('surfaces a scope-resolution failure without a partial search', async () => {
    mockResolveScope.mockRejectedValue(new Error('lake lookup failed'));

    await expect(handler(makeReq({ query: 'onboarding' }), makeRes())).rejects.toThrow('lake lookup failed');
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('sends no retrievalFilter - the route has no session to derive one from', async () => {
    await handler(makeReq({ query: 'onboarding' }), makeRes());

    // Deliberate divergence from the chat tool, which forwards context.retrievalFilter.
    expect(searchParams().retrievalFilter).toBeUndefined();
  });

  it('resolves scope through the shared helper for an admin too, with no route-local privilege branch', async () => {
    await handler(makeReq({ query: 'onboarding' }, { id: 'admin', tags: [], isAdmin: true }), makeRes());

    expect(mockResolveScope).toHaveBeenCalledTimes(1);
    expect(searchParams()).toMatchObject({ scopedTagPrefixes: DYNAMIC_SCOPE.scopedTagPrefixes });
  });

  it('maps chunk results onto the response contract the RLM loopback consumes', async () => {
    mockSemanticSearch.mockResolvedValue({
      results: [
        {
          chunkId: 'c1',
          fileId: 'f1',
          fileName: 'handbook.md',
          fileTags: ['acme:policy'],
          chunkText: 'pto policy',
          score: 0.82,
        },
      ],
      totalChunksSearched: 12,
      filesInScope: 3,
      chunksScored: 12,
      embeddingModel: 'text-embedding-ada-002',
      embeddingMismatch: emptyEmbeddingMismatchReport(),
    });
    const res = makeRes();

    await handler(makeReq({ query: 'pto' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [
          {
            chunk_id: 'c1',
            file_id: 'f1',
            file_name: 'handbook.md',
            file_tags: ['acme:policy'],
            chunk_text: 'pto policy',
            score: 0.82,
          },
        ],
        total_chunks_searched: 12,
        files_in_scope: 3,
      })
    );
  });
});

describe('POST /api/data-lakes/semantic-search partial-result reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveScope.mockResolvedValue(DYNAMIC_SCOPE);
    mockSemanticSearch.mockResolvedValue(EMPTY_RESULT);
    mockGetEffectiveApiKey.mockResolvedValue('test-openai-key');
    mockGetSettingsValue.mockResolvedValue('text-embedding-ada-002');
    mockFindUserById.mockResolvedValue(null);
  });

  it('flags a partial result and names the model to re-embed', async () => {
    mockSemanticSearch.mockResolvedValue({ ...EMPTY_RESULT, chunksScored: 3, embeddingMismatch: mismatchReport() });
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.partial_results).toBe(true);
    expect(body.chunks_scored).toBe(3);
    expect(body.embedding_mismatch.excluded_files).toEqual({
      count: 1,
      models: ['text-embedding-3-small'],
      estimated_chunks: 4,
      sample: [{ file_id: 'f9', file_name: 'foreign.md', embedding_model: 'text-embedding-3-small' }],
    });
    expect(body.embedding_mismatch.skipped_chunks.by_reason).toEqual({
      unknown_file: 0,
      model_mismatch: 0,
      missing_vector: 1,
      dimension_mismatch: 1,
    });
    // The reader needs both models to know what to re-embed and what it was compared against.
    expect(body.warning).toContain('text-embedding-3-small');
    expect(body.warning).toContain('text-embedding-ada-002');
  });

  it('still forwards the caller top_k, min_score and tags to the service', async () => {
    // Guards a regression from editing the service call while adding response fields.
    await handler(makeReq({ query: 'onboarding', top_k: 3, min_score: 0.5, tags: ['acme:x'] }), makeRes());

    expect(searchParams()).toMatchObject({ topK: 3, minScore: 0.5, tags: ['acme:x'] });
  });

  it('adds no warning key at all to a healthy search', async () => {
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.partial_results).toBe(false);
    // Absent, not present-and-undefined: a consistent lake gains no noise.
    expect('warning' in body).toBe(false);
    expect(body.embedding_mismatch.skipped_chunks.total).toBe(0);
    expect(body.embedding_mismatch.query_embedding_failed).toBe(false);
  });

  it('reports an embedder failure as its own cause, not as excluded files', async () => {
    const report = emptyEmbeddingMismatchReport();
    report.queryEmbeddingFailed = true;
    report.partial = true;
    mockSemanticSearch.mockResolvedValue({ ...EMPTY_RESULT, embeddingMismatch: report });
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.embedding_mismatch.query_embedding_failed).toBe(true);
    expect(body.warning).toContain('could not be embedded');
    // Pointing at re-embedding files would send the reader after the wrong thing.
    expect(body.warning).not.toContain('Re-embed');
  });
});

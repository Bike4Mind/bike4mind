import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const {
  mockResolveScope,
  mockSemanticSearch,
  mockGetEffectiveApiKey,
  mockGetEffectiveLLMApiKeys,
  mockFindUserById,
  mockGetSettingsValue,
  mockResolveSearchBudgets,
} = vi.hoisted(() => ({
  mockResolveScope: vi.fn(),
  mockSemanticSearch: vi.fn(),
  mockGetEffectiveApiKey: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockFindUserById: vi.fn(),
  mockGetSettingsValue: vi.fn(),
  mockResolveSearchBudgets: vi.fn(),
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
// The report helpers are the REAL ones: the wording and snake_case mapping are what these tests
// check, so a reimplementation here would prove nothing. Imported from source because the module
// is pure, while pulling the whole services barrel into jsdom is not.
vi.mock('@bike4mind/services', async () => ({
  apiKeyService: {
    getEffectiveApiKey: mockGetEffectiveApiKey,
    getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys,
  },
  ...(await import('../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch').then(m => ({
    __mismatch: m,
  }))),
  dataLakeService: {
    semanticDataLakeSearch: mockSemanticSearch,
    describeEmbeddingMismatch: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch')
    ).describeEmbeddingMismatch,
    emptyEmbeddingMismatchReport: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch')
    ).emptyEmbeddingMismatchReport,
    resolveSearchBudgets: mockResolveSearchBudgets,
    emptyScanAccounting: (b?: { maxFiles?: number; maxChunks?: number }) => ({
      truncated: false,
      fileBudgetHit: false,
      chunkBudgetHit: false,
      filesMatching: 0,
      filesScoped: 0,
      filesScanned: 0,
      chunksScanned: 0,
      chunksSkippedDimensionMismatch: 0,
      budgets: { maxFiles: b?.maxFiles ?? 20000, maxChunks: b?.maxChunks ?? 100000 },
    }),
  },
  recordOperationalUsage: vi.fn(),
}));

import handler from '@pages/api/data-lakes/semantic-search';
import { emptyEmbeddingMismatchReport } from '../../../../../../b4m-core/services/src/dataLakeService/embeddingMismatch';

const DYNAMIC_SCOPE = {
  dataLakeTags: ['datalake:acme-handbook'],
  dataLakeTagPrefixes: ['opti:'],
  scopedTagPrefixes: ['acme:'],
};

const FULL_SCAN = {
  truncated: false,
  fileBudgetHit: false,
  chunkBudgetHit: false,
  filesMatching: 3,
  filesScoped: 3,
  filesScanned: 3,
  chunksScanned: 12,
  chunksSkippedDimensionMismatch: 0,
  budgets: { maxFiles: 20000, maxChunks: 100000 },
};
const EMPTY_RESULT = {
  results: [],
  totalChunksSearched: 0,
  filesInScope: 0,
  chunksScored: 0,
  embeddingModel: 'text-embedding-ada-002',
  embeddingMismatch: emptyEmbeddingMismatchReport(),
  scan: { ...FULL_SCAN, filesMatching: 0, filesScoped: 0, filesScanned: 0, chunksScanned: 0 },
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
    mockResolveSearchBudgets.mockResolvedValue({ maxFiles: 20000, maxChunks: 100000 });
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
        files_in_scope: 0,
        embedding_model: 'text-embedding-ada-002',
        // The short-circuit must carry the SAME shape as the success path: the RLM loopback
        // forwards this JSON verbatim, so a missing `scan` would be an inconsistent contract.
        scan: expect.objectContaining({ truncated: false, files_matching: 0, chunks_scanned: 0 }),
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
      chunksScored: 12,
      embeddingMismatch: emptyEmbeddingMismatchReport(),
      filesInScope: 3,
      embeddingModel: 'text-embedding-ada-002',
      scan: FULL_SCAN,
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

describe('POST /api/data-lakes/semantic-search scan accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveScope.mockResolvedValue(DYNAMIC_SCOPE);
    mockGetEffectiveApiKey.mockResolvedValue('test-openai-key');
    mockGetSettingsValue.mockResolvedValue('text-embedding-ada-002');
    mockFindUserById.mockResolvedValue(null);
    mockResolveSearchBudgets.mockResolvedValue({ maxFiles: 20000, maxChunks: 100000 });
  });

  it('reports a complete scan as not truncated, with the flat counters agreeing with scan', async () => {
    mockSemanticSearch.mockResolvedValue({
      results: [],
      totalChunksSearched: 12,
      chunksScored: 12,
      embeddingMismatch: emptyEmbeddingMismatchReport(),
      filesInScope: 3,
      embeddingModel: 'text-embedding-ada-002',
      scan: FULL_SCAN,
    });
    const res = makeRes();

    await handler(makeReq({ query: 'pto' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.scan.truncated).toBe(false);
    // The pre-existing flat fields must keep meaning the same thing as the new block.
    expect(body.total_chunks_searched).toBe(body.scan.chunks_scanned);
    expect(body.files_in_scope).toBe(body.scan.files_scoped);
  });

  it('surfaces a truncated scan so a caller cannot read an absence of hits as an absence of content', async () => {
    mockSemanticSearch.mockResolvedValue({
      results: [],
      totalChunksSearched: 100000,
      chunksScored: 12,
      embeddingMismatch: emptyEmbeddingMismatchReport(),
      filesInScope: 2314,
      embeddingModel: 'text-embedding-ada-002',
      scan: {
        truncated: true,
        fileBudgetHit: false,
        chunkBudgetHit: true,
        filesMatching: 2314,
        filesScoped: 2314,
        filesScanned: 800,
        chunksScanned: 100000,
        chunksSkippedDimensionMismatch: 7,
        budgets: { maxFiles: 20000, maxChunks: 100000 },
      },
    });
    const res = makeRes();

    await handler(makeReq({ query: 'pto' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        scan: expect.objectContaining({
          truncated: true,
          chunk_budget_hit: true,
          file_budget_hit: false,
          files_scanned: 800,
          files_matching: 2314,
          chunks_skipped_dimension_mismatch: 7,
          budgets: { max_files: 20000, max_chunks: 100000 },
        }),
      })
    );
  });

  it('passes the operator-configured budgets into the search', async () => {
    mockResolveSearchBudgets.mockResolvedValue({ maxFiles: 50, maxChunks: 100 });
    mockSemanticSearch.mockResolvedValue(EMPTY_RESULT);

    await handler(makeReq({ query: 'pto' }), makeRes());

    expect(searchParams().budgets).toEqual({ maxFiles: 50, maxChunks: 100 });
  });
});

describe('POST /api/data-lakes/semantic-search embedding-mismatch reporting', () => {
  const SMALL_3 = 'text-embedding-3-small';

  const mismatchReport = () => {
    const report = emptyEmbeddingMismatchReport();
    report.excludedFiles = {
      count: 1,
      models: [SMALL_3],
      estimatedChunks: 4,
      sample: [{ fileId: 'f9', fileName: 'foreign.md', embeddingModel: SMALL_3 }],
    };
    report.partial = true;
    return report;
  };

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
    expect(body.embedding_mismatch.excluded_files.models).toEqual([SMALL_3]);
    expect(body.warning).toContain(SMALL_3);
  });

  it('adds no warning key at all to a healthy search', async () => {
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.partial_results).toBe(false);
    expect('warning' in body).toBe(false);
  });

  it('reports mismatch independently of scan truncation - they are different facts', async () => {
    // A lake can be fully scanned and still return content that could not be compared, and vice
    // versa; a caller must be able to tell the two apart.
    mockSemanticSearch.mockResolvedValue({ ...EMPTY_RESULT, embeddingMismatch: mismatchReport() });
    const res = makeRes();

    await handler(makeReq({ query: 'onboarding' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.partial_results).toBe(true);
    expect(body.scan.truncated).toBe(false);
  });
});

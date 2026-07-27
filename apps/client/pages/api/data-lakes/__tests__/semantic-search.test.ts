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
vi.mock('@bike4mind/services', () => ({
  apiKeyService: {
    getEffectiveApiKey: mockGetEffectiveApiKey,
    getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys,
  },
  dataLakeService: { semanticDataLakeSearch: mockSemanticSearch },
  recordOperationalUsage: vi.fn(),
}));

import handler from '@pages/api/data-lakes/semantic-search';

const DYNAMIC_SCOPE = {
  dataLakeTags: ['datalake:acme-handbook'],
  dataLakeTagPrefixes: ['opti:'],
  scopedTagPrefixes: ['acme:'],
};

const EMPTY_RESULT = { results: [], totalChunksSearched: 0, filesInScope: 0, embeddingModel: 'text-embedding-ada-002' };

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
      expect.objectContaining({ results: [], total_chunks_searched: 0, embedding_model: 'text-embedding-ada-002' })
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
      embeddingModel: 'text-embedding-ada-002',
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

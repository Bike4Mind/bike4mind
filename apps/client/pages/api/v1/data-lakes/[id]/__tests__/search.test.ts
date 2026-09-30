// @vitest-environment node
/**
 * Route tests for POST /api/v1/data-lakes/{id}/search. The shared search core
 * (runLakeSemanticSearch) is stubbed - the SPA route's suite covers it - so what is under test is
 * this door's scope narrowing, its error mapping and its projection onto the published shape. The
 * narrowing helper itself is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  DataLakeSearchResponseSchema,
  NotFoundError,
  insufficientCreditsError,
  searchDataLakeContract,
} from '@bike4mind/common';

const { mockAssertLakeAccess, mockResolveScope, mockRunSearch, mockRateLimitOptions, mockFeatureEnabled } = vi.hoisted(
  () => ({
    mockAssertLakeAccess: vi.fn(),
    mockResolveScope: vi.fn(),
    mockRunSearch: vi.fn(),
    mockRateLimitOptions: vi.fn(),
    mockFeatureEnabled: { value: true },
  })
);

// Keeps next-connect's registrar shape and runs `.use()` middleware ahead of each handler, so the
// feature-flag gate is exercised alongside the contract prelude.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.post = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled:
    () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      mockFeatureEnabled.value
        ? next()
        : res.status(403).json({ error: 'Feature not available', code: 'FEATURE_DISABLED' }),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
// Two DISTINCT contexts so a test can tell which builder the route actually called: the admin
// context bypasses lake access and must never reach `assertLakeAccess` on this member-scoped route.
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async () => ({ userId: 'u1', isAdmin: true, userTags: [], organizationIds: [] }),
  toMemberAccessContext: async () => ({ userId: 'u1', isAdmin: false, userTags: [], organizationIds: [] }),
}));
vi.mock('@server/dataLakes/resolveRetrievalLakeScope', () => ({ resolveRetrievalLakeScope: mockResolveScope }));
vi.mock('@server/dataLakes/runLakeSemanticSearch', () => ({ runLakeSemanticSearch: mockRunSearch }));
vi.mock('@server/utils/resolveDefaultEmbeddingModel', () => ({
  resolveDefaultEmbeddingModel: async () => 'text-embedding-3-small',
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, dataLakeService: { ...actual.dataLakeService, assertLakeAccess: mockAssertLakeAccess } };
});

const { default: handler } = await import('@pages/api/v1/data-lakes/[id]/search');
// Captured before any beforeEach clears it: the limiter is built once, at module load.
const rateLimitOptionsAtLoad: unknown = mockRateLimitOptions.mock.calls[0]?.[0];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const lake = (key: string, creator = 'u1') => ({
  id: `lake-${key}`,
  name: key,
  slug: key,
  datalakeTag: `datalake:${key}`,
  fileTagPrefix: `${key}:`,
  createdByUserId: creator,
});
const TARGET = lake('target');
const OTHER = lake('other', 'u2');

/** The retrieval resolver's view: the caller can retrieve from BOTH lakes. */
const BOTH_LAKES_SCOPE = {
  dataLakeTags: [TARGET.datalakeTag, OTHER.datalakeTag],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [TARGET.fileTagPrefix, OTHER.fileTagPrefix],
  lakes: [TARGET, OTHER],
  lakeViewComplete: true,
};

const emptyReport = { count: 0, sample: [] };
const SEARCH = {
  results: [
    {
      chunkId: 'c1',
      fileId: 'f1',
      fileName: 'guide.pdf',
      fileTags: ['datalake:target'],
      chunkText: 'Refunds within 30 days.',
      score: 0.91,
    },
  ],
  embeddingModel: 'text-embedding-3-small',
  embeddingMismatch: {
    partial: false,
    excludedFiles: { count: 0, models: [], estimatedChunks: 0, sample: [] },
    skippedChunks: { total: 0, byReason: {} },
    unlabeled: { chunks: 0, files: 0 },
    alternateModelServed: { files: 0, models: [] },
    queryEmbeddingFailed: false,
  },
  retrievalUnavailable: { indexing: { count: 2, sample: [] }, paused: { count: 1, sample: [] }, partial: true },
  supersession: { ...emptyReport, partial: false },
};

async function run(body: Record<string, unknown> = { query: 'refund policy' }) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'target' }, body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeatureEnabled.value = true;
  mockAssertLakeAccess.mockResolvedValue(TARGET);
  mockResolveScope.mockResolvedValue(BOTH_LAKES_SCOPE);
  mockRunSearch.mockResolvedValue({ kind: 'ok', search: SEARCH });
});

describe('POST /api/v1/data-lakes/{id}/search', () => {
  it('searches only the target lake, restricted to its members, and projects the public shape', async () => {
    const res = await run({ query: 'refund policy', top_k: 5, tags: ['policy'] });
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(DataLakeSearchResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      results: [
        { chunk_id: 'c1', file_id: 'f1', file_name: 'guide.pdf', chunk_text: 'Refunds within 30 days.', score: 0.91 },
      ],
      embedding_model: 'text-embedding-3-small',
      partial_results: true,
      retrieval_unavailable: { indexing_files: 2, paused_files: 1 },
    });

    const [, input] = mockRunSearch.mock.calls[0];
    expect(input.scope.dataLakeTags).toEqual([TARGET.datalakeTag]);
    expect(input.scope.lakes).toEqual([TARGET]);
    expect(input.scope.scopedTagPrefixes).toEqual([TARGET.fileTagPrefix]);
    expect(JSON.stringify(input.scope)).not.toContain(OTHER.datalakeTag);
    expect(input).toMatchObject({
      query: 'refund policy',
      topK: 5,
      minScore: 0,
      tags: ['policy'],
      restrictToDataLake: true,
      embeddingModelExplicit: false,
      // Its own value, distinct from the SPA route's, so the two doors' traffic can be told apart
      // in the lake access history even though they share this same search core.
      surface: 'data-lake-api-v1-search',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('applies the documented defaults when only a query is sent', async () => {
    const res = await run({ query: 'q' });
    expect(res._getStatusCode()).toBe(200);
    expect(mockRunSearch.mock.calls[0][1]).toMatchObject({ topK: 10, minScore: 0, tags: [] });
  });

  it('404s a lake the caller cannot see, before resolving any scope', async () => {
    mockAssertLakeAccess.mockRejectedValue(new NotFoundError('Data lake not found'));
    await expect(run()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockResolveScope).not.toHaveBeenCalled();
    expect(mockRunSearch).not.toHaveBeenCalled();
  });

  it('404s a lake the caller can read but not retrieve from, never widening to the full scope', async () => {
    mockResolveScope.mockResolvedValue({
      ...BOTH_LAKES_SCOPE,
      dataLakeTags: [OTHER.datalakeTag],
      scopedTagPrefixes: [OTHER.fileTagPrefix],
      lakes: [OTHER],
    });
    await expect(run()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRunSearch).not.toHaveBeenCalled();
  });

  it('maps a missing embedding credential to 503 provider_not_configured', async () => {
    mockRunSearch.mockResolvedValue({ kind: 'provider_not_configured', message: 'openai API key not configured.' });
    await expect(run()).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { errorCode: 'provider_not_configured' },
    });
  });

  it('lets the credit pre-flight 422 through', async () => {
    mockRunSearch.mockRejectedValue(insufficientCreditsError('Not enough credits'));
    await expect(run()).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { errorCode: 'insufficient_credits' },
    });
  });

  it('rejects an invalid body with a validation error before any lookup', async () => {
    await expect(run({ query: '' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(run({ query: 'q', top_k: 0 })).rejects.toMatchObject({ name: 'ZodError' });
    expect(mockAssertLakeAccess).not.toHaveBeenCalled();
  });

  it('shares the SPA semantic-search rate-limit bucket', () => {
    expect(rateLimitOptionsAtLoad).toEqual(
      expect.objectContaining({ bucket: '/api/data-lakes/semantic-search', windowMs: 60_000 })
    );
  });

  it('answers 403 FEATURE_DISABLED when Data Lakes are off', async () => {
    mockFeatureEnabled.value = false;
    const res = await run();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mockRunSearch).not.toHaveBeenCalled();
  });

  it('ends the response without a body when the search core reports the caller aborted', async () => {
    mockRunSearch.mockResolvedValue({ kind: 'aborted' });
    const res = await run();
    expect(res._isEndCalled()).toBe(true);
    expect(res._isJSON()).toBe(false);
    expect(res._getStatusCode()).toBeLessThan(500);
  });

  it('flips the isAborted flag passed to the core only on a close before the response ends', async () => {
    let resolveSearch: (outcome: { kind: 'aborted' }) => void = () => {};
    mockRunSearch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSearch = resolve;
        })
    );
    const { req, res } = createMocks({ method: 'POST', query: { id: 'target' }, body: { query: 'refund policy' } });
    Object.assign(req, { user: { id: 'u1' }, logger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
    const handlerPromise = (handler as any)(req, res);

    await vi.waitFor(() => {
      if (mockRunSearch.mock.calls.length === 0) throw new Error('runLakeSemanticSearch not called yet');
    });
    const isAborted = mockRunSearch.mock.calls[0][1].isAborted;

    expect(isAborted()).toBe(false);
    req.emit('close');
    expect(isAborted()).toBe(true);

    resolveSearch({ kind: 'aborted' });
    await handlerPromise;
  });

  it('does not flip isAborted on a close that fires after the response has already ended', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'target' }, body: { query: 'refund policy' } });
    Object.assign(req, { user: { id: 'u1' }, logger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
    await (handler as any)(req, res);

    const isAborted = mockRunSearch.mock.calls[0][1].isAborted;
    expect(res.writableEnded).toBe(true);
    req.emit('close');
    expect(isAborted()).toBe(false);
  });

  it('is published under the query-only scope', () => {
    expect(searchDataLakeContract.scopes).toEqual(['datalake:query']);
  });

  // Regression for the admin-bypass gap: fails if the route resolved `toAccessContext` (isAdmin:
  // true) instead of `toMemberAccessContext` (isAdmin: false).
  it('resolves a member-scoped context, never the admin-bypass one', async () => {
    await run();
    expect(mockAssertLakeAccess).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({ isAdmin: false }),
      expect.anything()
    );
  });
});

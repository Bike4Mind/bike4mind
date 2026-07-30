import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  batchFindById: vi.fn(),
  lakeFindById: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  fabFindByBatchId: vi.fn(),
  getEffectiveApiKey: vi.fn(),
  runTaxonomyInference: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
// No-op rate limiter: the daily-cap policy itself isn't this test's concern.
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@server/utils/config', () => ({ isDevelopment: () => false }));
vi.mock('@server/dataLakes/runTaxonomyInference', () => ({
  runTaxonomyInference: h.runTaxonomyInference,
  sampleFabFilesForTaxonomy: (files: unknown[]) => files,
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { findById: h.batchFindById, setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive },
  dataLakeRepository: { findById: h.lakeFindById },
  fabFileRepository: { findByBatchId: h.fabFindByBatchId },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: h.getEffectiveApiKey },
}));

import handler from '../reanalyze-taxonomy';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (
  batchId: string,
  body: unknown = {},
  user: { id: string; isAdmin: boolean } = { id: 'u1', isAdmin: false }
) => ({ method: 'POST', user, query: { batchId }, body, logger: { error: vi.fn() } }) as never;
const run = (batchId: string, res: unknown, body?: unknown, user?: { id: string; isAdmin: boolean }) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(batchId, body, user), res);

describe('POST /api/data-lakes/batches/[batchId]/reanalyze-taxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake1' });
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'u1', fileTagPrefix: 'acme:' });
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1', taxonomyStatus: 'analyzing' });
    h.fabFindByBatchId.mockResolvedValue([{ relativePath: 'legal/a.pdf', fileName: 'a.pdf', fileSize: 10 }]);
    h.getEffectiveApiKey.mockResolvedValue('sk-test');
    h.runTaxonomyInference.mockResolvedValue({
      suggestedPrefix: 'acme:',
      suggestedName: '',
      categories: [{ tagName: 'acme:type:contract', confidence: 0.9, matchingFolders: ['legal'] }],
      fileAssignments: [],
    });
  });

  it('rejects a non-owner, non-admin caller before touching the taxonomy phase', async () => {
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'someone-else', fileTagPrefix: 'acme:' });
    const { res } = makeRes();

    await expect(run('b1', res)).rejects.toThrow(/creator/i);
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  it('404s for a missing batch or lake', async () => {
    h.batchFindById.mockResolvedValue(null);
    await expect(run('b1', makeRes().res)).rejects.toThrow(/batch not found/i);

    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake1' });
    h.lakeFindById.mockResolvedValue(null);
    await expect(run('b1', makeRes().res)).rejects.toThrow(/data lake not found/i);
  });

  it('refuses when the guarded claim is lost (not currently ready/failed)', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue(null);
    const { res } = makeRes();

    await run('b1', res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(h.fabFindByBatchId).not.toHaveBeenCalled();
  });

  it('refreshes taxonomyStartedAt on the claim, so the stuck-job reconciler times out from now', async () => {
    const { res } = makeRes();

    await run('b1', res);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['ready', 'failed'],
      'analyzing',
      expect.objectContaining({ taxonomyStartedAt: expect.any(Date) })
    );
  });

  it('fails closed with a clear message when no OpenAI key is configured', async () => {
    h.getEffectiveApiKey.mockResolvedValue(null);
    const { res } = makeRes();

    await run('b1', res);

    expect(h.runTaxonomyInference).not.toHaveBeenCalled();
    expect(h.setTaxonomyStatusIfActive).toHaveBeenLastCalledWith(
      'b1',
      ['analyzing'],
      'failed',
      expect.objectContaining({ taxonomyError: expect.stringMatching(/api key/i) })
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('samples using the lake own fixed prefix, not the model suggestion, and stores sanitized results as ready', async () => {
    const { res, json } = makeRes();

    await run('b1', res, { context: 'legal docs' });

    expect(h.runTaxonomyInference).toHaveBeenCalledWith('sk-test', expect.anything(), {
      existingPrefix: 'acme:',
      context: 'legal docs',
    });
    expect(h.setTaxonomyStatusIfActive).toHaveBeenLastCalledWith(
      'b1',
      ['analyzing'],
      'ready',
      expect.objectContaining({
        taxonomySuggestions: expect.objectContaining({
          tags: expect.arrayContaining([expect.objectContaining({ originalName: 'acme:type:contract' })]),
        }),
      })
    );
    expect(json).toHaveBeenCalled();
  });
});

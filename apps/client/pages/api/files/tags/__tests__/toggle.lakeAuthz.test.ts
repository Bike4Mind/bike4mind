import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The route's lake-write gate, run for real against fake repos. The sibling toggle.test.ts mocks
 * `assertCanWriteDataLakeTags` away, so only this spec can tell whether the actor the route hands
 * that gate is wide enough: `canManageLake`'s org-admin rung reads `administeredOrgIds`, which a
 * `{ userId, isAdmin }` literal does not carry, and narrowing it refuses a caller every other
 * lake-management gate in the app admits.
 */
const h = vi.hoisted(() => ({
  findByDatalakeTag: vi.fn(),
  listByLake: vi.fn(),
  listActiveByLakes: vi.fn(),
  findAllUpdateAccessByIds: vi.fn(),
  findById: vi.fn(),
  pushTagsByFabFileId: vi.fn(),
  pullTagsByFabFileId: vi.fn(),
  computeDataLakeStats: vi.fn(),
  administeredOrgIds: [] as string[],
  recordConfigChange: vi.fn(),
  activateIfDraft: vi.fn(),
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
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
// Nothing of @bike4mind/services is stubbed: the route gate AND the service's own re-gate inside
// `addFileToLake` both have to admit the caller, and only the second of those is what a narrowed
// actor breaks on this door.
vi.mock('@bike4mind/database', () => ({
  lakeConfigChangeEventRepository: { record: h.recordConfigChange },
  dataLakeRepository: {
    findByDatalakeTag: h.findByDatalakeTag,
    find: vi.fn().mockResolvedValue([]),
    setStats: vi.fn().mockResolvedValue(undefined),
    activateIfDraft: h.activateIfDraft,
  },
  dataLakeAccessGrantRepository: { listByLake: h.listByLake, listActiveByLakes: h.listActiveByLakes },
  fabFileRepository: {
    shareable: { findAllUpdateAccessByIds: h.findAllUpdateAccessByIds },
    findById: h.findById,
    pushTagsByFabFileId: h.pushTagsByFabFileId,
    pullTagsByFabFileId: h.pullTagsByFabFileId,
    computeDataLakeStats: h.computeDataLakeStats,
  },
  fileTagRepository: { touchLastActivityBy: vi.fn().mockResolvedValue(undefined) },
  userRepository: { findById: vi.fn(async (id: string) => ({ id, isAdmin: false })) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  scopedSettingsRepository: { findOverrides: vi.fn().mockResolvedValue([]) },
}));
// Stubbed so the actor's org-admin set is a test input rather than a Mongo read; the gate that
// consumes it is the real one.
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async (req: { user: { id: string; isAdmin?: boolean } }) => ({
    userId: req.user.id,
    isAdmin: !!req.user.isAdmin,
    userTags: [],
    organizationIds: [],
    entitlementKeys: [],
    administeredOrgIds: h.administeredOrgIds,
  }),
}));

import handler from '../toggle';

const META = 'datalake:orga:acme-2026';
// Created by someone else and scoped to an org, so the creator rung cannot be what admits the
// caller - only the org-admin or a grant rung can.
const LAKE = {
  id: 'lake-1',
  slug: 'acme-2026',
  createdByUserId: 'someone-else',
  organizationId: 'org-1',
  datalakeTag: META,
  fileTagPrefix: 'acme:',
};

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const call = (body: unknown, res: unknown, apiKeyInfo?: { keyId: string }) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      body,
      user: { id: 'u2', isAdmin: false },
      apiKeyInfo,
      logger: { error: vi.fn(), warn: vi.fn() },
    } as never,
    res
  );

describe('POST /api/files/tags/toggle - lake write authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.administeredOrgIds = [];
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.listByLake.mockResolvedValue([]);
    h.listActiveByLakes.mockResolvedValue([]);
    const file = { id: 'f1', userId: 'u2', tags: [] };
    h.findAllUpdateAccessByIds.mockResolvedValue([{ ...file, toJSON: () => file }]);
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 1, totalSizeBytes: 0, totalChunkedChars: 0 });
    h.recordConfigChange.mockResolvedValue({});
    h.activateIfDraft.mockResolvedValue(undefined);
  });

  it('admits an org admin of the lake org who holds no grant and did not create it', async () => {
    h.administeredOrgIds = ['org-1'];
    const { res } = makeRes();

    await call({ ids: ['f1'], tags: [META] }, res);

    expect(h.pushTagsByFabFileId).toHaveBeenCalledWith('f1', [META], expect.any(Number));
  });

  it('admits a curator grant holder', async () => {
    h.listByLake.mockResolvedValue([{ principalType: 'user', principalId: 'u2', role: 'curator' }]);
    const { res } = makeRes();

    await call({ ids: ['f1'], tags: [META] }, res);

    expect(h.pushTagsByFabFileId).toHaveBeenCalledWith('f1', [META], expect.any(Number));
  });

  it('admits an org admin removing a file from the lake', async () => {
    h.administeredOrgIds = ['org-1'];
    const file = { id: 'f1', userId: 'u2', tags: [{ name: META, strength: 1 }] };
    h.findAllUpdateAccessByIds.mockResolvedValue([{ ...file, toJSON: () => file }]);
    // removeFileFromLake re-reads the file itself to compute which tags to pull.
    h.findById.mockResolvedValue(file);
    const { res } = makeRes();

    await call({ ids: ['f1'], tags: [META] }, res);

    expect(h.pullTagsByFabFileId).toHaveBeenCalledWith('f1', [META]);
  });

  it('still refuses a caller with no manage rung at all', async () => {
    const { res } = makeRes();

    await expect(call({ ids: ['f1'], tags: [META] }, res)).rejects.toThrow(
      /permission to change this data lake's files/
    );
    expect(h.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  /**
   * The end-to-end half of #1964, through the REAL service and recompute to the audit repo - the
   * shape #2124 established for the file-write doors. toggle.test.ts pins what the ROUTE resolves
   * and toggleTags.test.ts pins what the SERVICE records; only this one proves the two halves
   * actually meet on a live draft-lake activation.
   */
  it('records the API key on the auto-activate row a key-driven toggle triggers', async () => {
    h.administeredOrgIds = ['org-1'];
    h.findByDatalakeTag.mockResolvedValue({ ...LAKE, status: 'draft' });
    h.activateIfDraft.mockResolvedValue(true);
    const { res } = makeRes();

    await call({ ids: ['f1'], tags: [META] }, res, { keyId: 'key-abc' });

    expect(h.recordConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auto-activate',
        principalKind: 'apiKey',
        principalId: 'key-abc',
        onBehalfOfUserId: 'u2',
        // Unchanged by the principal: activateIfDraft authorizes nothing (see recomputeLakeStats).
        manageRung: 'system',
      })
    );
  });

  it('records the session user on that same row when no key is involved', async () => {
    h.administeredOrgIds = ['org-1'];
    h.findByDatalakeTag.mockResolvedValue({ ...LAKE, status: 'draft' });
    h.activateIfDraft.mockResolvedValue(true);
    const { res } = makeRes();

    await call({ ids: ['f1'], tags: [META] }, res);

    expect(h.recordConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto-activate', principalKind: 'user', principalId: 'u2' })
    );
    expect('onBehalfOfUserId' in h.recordConfigChange.mock.calls[0][0]).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  applyCorpusAction: vi.fn(),
  lakeConfigAuditPrincipal: vi.fn(() => undefined as unknown),
  toAccessContext: vi.fn(async () => ({ userId: 'curator-1', isAdmin: false })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => unknown) => unknown)[] = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        let index = 0;
        const next = async (): Promise<unknown> => {
          const middleware = middlewares[index++];
          if (middleware) return middleware(req, res, next);
          return routes[req.method ?? 'POST']?.(req, res);
        };
        return next();
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => unknown) => unknown) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ DATA_LAKE_WRITE_SCOPES: [] }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { applyCorpusAction: h.applyCorpusAction },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeCorpusActionRepository: {},
  dataLakeFindingRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  lakeMembershipRemovalRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({
  lakeConfigAuditPrincipal: h.lakeConfigAuditPrincipal,
}));

import handler from '../[findingId]/corpus-action';

const invoke = (body: Record<string, unknown>) => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', query: { id: 'lake1', findingId: 'f1' }, body, user: { id: 'curator-1' } },
      res
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.applyCorpusAction.mockResolvedValue({ action: 'merge', findingId: 'f1', targets: [], detail: {} });
});

describe('POST /api/data-lakes/[id]/findings/[findingId]/corpus-action (#3046)', () => {
  it('passes a merge through to the service with the lake and finding from the path', async () => {
    const { done, json } = invoke({ action: 'merge', keepFabFileId: 'a', retireFabFileIds: ['b'] });
    await done;

    expect(h.applyCorpusAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'curator-1' }),
      'lake1',
      'f1',
      expect.objectContaining({ action: 'merge', keepFabFileId: 'a', retireFabFileIds: ['b'] }),
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'merge' }) });
  });

  it('wires the restore-record repository, without which a merge has no Undo', async () => {
    const { done } = invoke({ action: 'merge', keepFabFileId: 'a', retireFabFileIds: ['b'] });
    await done;

    const deps = h.applyCorpusAction.mock.calls[0][4] as { db: Record<string, unknown> };
    expect(deps.db).toHaveProperty('lakeMembershipRemovals');
    expect(deps.db).toHaveProperty('dataLakeCorpusActions');
  });

  it('attaches the API-key principal so a key-driven action is not recorded as the human', async () => {
    h.lakeConfigAuditPrincipal.mockReturnValueOnce({
      principalKind: 'api-key',
      principalId: 'key-1',
      onBehalfOfUserId: 'curator-1',
    });
    const { done } = invoke({ action: 'supersede', keepFabFileId: 'a', retireFabFileId: 'b' });
    await done;

    expect(h.applyCorpusAction.mock.calls[0][0]).toMatchObject({
      auditPrincipal: { principalKind: 'api-key', principalId: 'key-1' },
    });
  });

  it('rejects an unknown action rather than passing it down', async () => {
    const { done } = invoke({ action: 'delete-everything', fabFileId: 'a' });
    await expect(done).rejects.toThrow();
    expect(h.applyCorpusAction).not.toHaveBeenCalled();
  });

  it('rejects a merge that retires nothing', async () => {
    const { done } = invoke({ action: 'merge', keepFabFileId: 'a', retireFabFileIds: [] });
    await expect(done).rejects.toThrow();
    expect(h.applyCorpusAction).not.toHaveBeenCalled();
  });

  it('accepts a retag that clears every tag, since the body is the complete desired set', async () => {
    h.applyCorpusAction.mockResolvedValue({ action: 'retag', findingId: 'f1', targets: [], detail: {} });
    const { done } = invoke({ action: 'retag', fabFileId: 'a', tags: [] });
    await done;

    expect(h.applyCorpusAction).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      'f1',
      expect.objectContaining({ action: 'retag', tags: [] }),
      expect.anything()
    );
  });
});

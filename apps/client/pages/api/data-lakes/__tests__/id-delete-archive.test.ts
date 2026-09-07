import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * DELETE /api/data-lakes/:id is the SECOND archive door (POST :id/lifecycle {action:'archive'} is
 * the other), and it is the wizard's rollback for a failed fileless Drive commit. The lifecycle
 * ports are opt-in per call site, so a door left unwired silently keeps the old behavior - here,
 * that means an archived lake whose Drive connection stays enabled and keeps getting enqueued by
 * the hourly re-sync poll forever. These pin the wiring, which nothing else can catch.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  archiveDataLake: vi.fn(),
  toAccessContext: vi.fn(),
  disableDriveConnectionForLake: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
  // Stubbed rather than omitted: the mock replaces the whole module, so a missing export the route
  // imports is an import-time failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
  },
  adminSettingsRepository: {
    getSettingsValue: vi.fn().mockResolvedValue(false),
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/integrations/google/drive/common', () => ({
  disableDriveConnectionForLake: h.disableDriveConnectionForLake,
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    archiveDataLake: h.archiveDataLake,
    updateDataLake: vi.fn(),
  },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const del = (over: Record<string, unknown> = {}) => ({ method: 'DELETE', query: { id: 'lake1' }, ...over }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe("DELETE /api/data-lakes/[id] - the archive door's Drive-connection port is wired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.archiveDataLake.mockResolvedValue({ id: 'lake1', status: 'archived' });
    h.disableDriveConnectionForLake.mockResolvedValue(true);
  });

  it('passes a disableDriveConnection port that reaches the real disable helper', async () => {
    const { res, json } = makeRes();
    await run(del({ user: { id: 'owner' } }), res);

    const opts = h.archiveDataLake.mock.calls[0][2] as {
      disableDriveConnection?: (args: { dataLakeId: string }) => Promise<void>;
    };
    expect(opts.disableDriveConnection).toBeTypeOf('function');
    // Call through: asserting only that SOME function was passed would still pass if it were wired
    // to the wrong helper (releaseDriveConnectionForLake hard-deletes the row, which unarchive
    // could never reverse).
    await opts.disableDriveConnection!({ dataLakeId: 'lake1' });
    expect(h.disableDriveConnectionForLake).toHaveBeenCalledWith('lake1');
    expect(json.mock.calls[0][0]).toMatchObject({ status: 'archived' });
  });

  it('archives with the writability gate ahead of the service, as the lifecycle door does', async () => {
    const { res } = makeRes();
    await run(del({ user: { id: 'owner' } }), res);
    expect(h.assertLakeWritable).toHaveBeenCalled();
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
      'lake1',
      expect.anything()
    );
  });

  it('attributes a key-driven archive to the KEY', async () => {
    const { res } = makeRes();
    await run(del({ user: { id: 'owner' }, apiKeyInfo: { keyId: 'key-abc' } }), res);
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: 'owner' },
      }),
      'lake1',
      expect.anything()
    );
  });
});

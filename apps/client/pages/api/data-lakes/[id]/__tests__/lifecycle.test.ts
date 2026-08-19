import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  archiveDataLake: vi.fn(),
  deleteDataLake: vi.fn(),
  unarchiveDataLake: vi.fn(),
  restoreDeletedDataLake: vi.fn(),
  cleanupDeletedDataLake: vi.fn(),
  acceptDataLakePurge: vi.fn(),
  releasePurgingToDeleted: vi.fn(),
  // Real admin-or-creator logic (not a bare stub) so the cleanup action's canManageLake call
  // behaves identically to production for these tests, including the blank-identity case.
  canManageLake: vi.fn(
    (lake: { createdByUserId?: string }, actor: { userId?: string; isAdmin: boolean }) =>
      actor.isAdmin || (!!actor.userId && !!lake.createdByUserId && lake.createdByUserId === actor.userId)
  ),
  loadActiveLakeGrants: vi.fn().mockResolvedValue([]),
  openSearchRetrievalIndex: vi.fn(() => ({ removeForDataLake: vi.fn() })),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/data-lake-cleanup'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
}));

// baseApi mock: callable chain routed by req.method (same shape as the serve/gears tests).
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
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    archiveDataLake: h.archiveDataLake,
    deleteDataLake: h.deleteDataLake,
    unarchiveDataLake: h.unarchiveDataLake,
    restoreDeletedDataLake: h.restoreDeletedDataLake,
    cleanupDeletedDataLake: h.cleanupDeletedDataLake,
    acceptDataLakePurge: h.acceptDataLakePurge,
    canManageLake: h.canManageLake,
    openSearchRetrievalIndex: h.openSearchRetrievalIndex,
    loadActiveLakeGrants: h.loadActiveLakeGrants,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { releasePurgingToDeleted: h.releasePurgingToDeleted },
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than
  // omitted because the mock replaces the whole module: a missing export is an import-time
  // failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeBatchRepository: {},
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));

import handler from '../lifecycle';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json, statusJson: json };
};
const req = (body: unknown) => ({ method: 'POST', query: { id: 'lake1' }, body }) as never;

describe('POST /api/data-lakes/[id]/lifecycle - cleanup action (enqueue offload)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeWritable.mockReturnValue(undefined);
    h.sendToQueue.mockResolvedValue(undefined);
    h.acceptDataLakePurge.mockResolvedValue(undefined);
  });

  it('enqueues the cleanup and returns 202 for the owner without running the sweep inline', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/data-lake-cleanup', {
      dataLakeId: 'lake1',
      actor: { userId: 'u1', isAdmin: false },
    });
    expect(h.cleanupDeletedDataLake).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('claims the purge BEFORE enqueueing, so the lake leaves the deleted list first (#1744)', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    const order: string[] = [];
    h.acceptDataLakePurge.mockImplementation(async () => void order.push('accept'));
    h.sendToQueue.mockImplementation(async () => void order.push('enqueue'));
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    // Ordering is the fix, not an implementation detail: enqueue-first leaves the accept window
    // this issue is about wide open, because the sweep can complete before the status ever moves.
    expect(order).toEqual(['accept', 'enqueue']);
    expect(h.acceptDataLakePurge).toHaveBeenCalledWith({ userId: 'u1', isAdmin: false }, 'lake1', expect.anything());
  });

  it('releases the claim when the enqueue fails, so the lake cannot strand in purging', async () => {
    // Without the release this is the one unrecoverable outcome: no list shows a purging lake, and
    // with no message enqueued there is nothing to alarm on or replay - only a manual DB edit.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    h.sendToQueue.mockRejectedValue(new Error('sqs unavailable'));
    const { res } = makeRes();
    await expect(
      (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res)
    ).rejects.toThrow(/sqs unavailable/);

    expect(h.releasePurgingToDeleted).toHaveBeenCalledWith('lake1');
    expect(res.status).not.toHaveBeenCalledWith(202);
  });

  it('does NOT release on a successful enqueue', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.releasePurgingToDeleted).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('does NOT enqueue when the claim is lost, so a refused purge leaves no orphan message', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    h.acceptDataLakePurge.mockRejectedValue(new Error('Data lake must be soft-deleted before cleanup'));
    const { res } = makeRes();
    await expect(
      (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res)
    ).rejects.toThrow(/soft-deleted/i);

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(202);
  });

  it('rejects with 403 and does not enqueue when a non-owner requests cleanup', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'someone-else' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.acceptDataLakePurge).not.toHaveBeenCalled();
  });

  it('rejects with 400 and does not enqueue when the lake is not soft-deleted', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'active', createdByUserId: 'u1' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('now delegates to canManageLake, so a blank-identity lake is rejected rather than granted (#1153)', async () => {
    h.toAccessContext.mockResolvedValueOnce({ userId: '', isAdmin: false });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: '' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.canManageLake).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

// Only self-host OpenSearch needs this port wired (see ports.ts) - Atlas's index lives on the
// FabFileChunk collection itself, so it needs no separate removal.
describe('POST /api/data-lakes/[id]/lifecycle - retrievalIndex wiring (archive/delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeWritable.mockReturnValue(undefined);
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'active', createdByUserId: 'u1' });
    h.archiveDataLake.mockResolvedValue({ id: 'lake1', status: 'archived' });
    h.deleteDataLake.mockResolvedValue({ id: 'lake1', status: 'deleted' });
    h.unarchiveDataLake.mockResolvedValue({ restoredCount: 0, skippedDuplicates: 0 });
    h.restoreDeletedDataLake.mockResolvedValue({ restoredCount: 0, skippedDuplicates: 0 });
  });

  // The audit repos are wired through one shared helper (lakeConfigAuditDb) precisely so the four
  // lake routes cannot drift into wiring three and forgetting the fourth. The service types now make
  // the event repo required, so a route that dropped it fails to COMPILE - this pins the other half,
  // `adminSettings`, which stays optional (the retention read is best-effort) and would otherwise go
  // missing silently, leaving every event on the floor default.
  it.each([
    ['archive', 'archiveDataLake'],
    ['unarchive', 'unarchiveDataLake'],
    ['restore', 'restoreDeletedDataLake'],
    ['delete', 'deleteDataLake'],
  ])('%s wires the config-audit repositories into the service', async (action, serviceName) => {
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action }), res);

    expect(h[serviceName as keyof typeof h]).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      })
    );
  });

  it('archive passes retrievalIndex: undefined when self-host OpenSearch is off', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'archive' }), res);

    expect(h.openSearchRetrievalIndex).not.toHaveBeenCalled();
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: undefined })
    );
  });

  it('archive wires a real retrievalIndex when self-host OpenSearch is on', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'archive' }), res);

    expect(h.openSearchRetrievalIndex).toHaveBeenCalled();
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: expect.objectContaining({ removeForDataLake: expect.anything() }) })
    );
  });

  it('delete passes retrievalIndex: undefined when self-host OpenSearch is off', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'delete' }), res);

    expect(h.openSearchRetrievalIndex).not.toHaveBeenCalled();
    expect(h.deleteDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: undefined })
    );
  });

  it('delete wires a real retrievalIndex when self-host OpenSearch is on', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'delete' }), res);

    expect(h.openSearchRetrievalIndex).toHaveBeenCalled();
    expect(h.deleteDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: expect.objectContaining({ removeForDataLake: expect.anything() }) })
    );
  });
});

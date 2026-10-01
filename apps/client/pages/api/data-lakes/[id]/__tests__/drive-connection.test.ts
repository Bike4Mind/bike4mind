import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test of the per-lake Drive connection status/disconnect route (D2). Repo, queue and auth gate
// mocked; the purge itself is driveDisconnectPurge's (see its unit and e2e suites).
const MARK_STAMP = new Date('2026-01-01T00:00:00Z');
const MARK = { stamp: MARK_STAMP, created: true, previousEnabled: true };
const STALE = new Date(Date.now() - 16 * 60 * 1000);

const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  connMarkDisconnecting: vi.fn(
    async (): Promise<{ stamp: Date; created: boolean; previousEnabled: boolean } | null> => MARK
  ),
  connCancelDisconnect: vi.fn(async () => true),
  fabFilesCountByDriveConnectionIdInDataLake: vi.fn(async () => 0),
  fabFilesFindByDriveConnectionIdInDataLake: vi.fn(async () => []),
  sendToQueue: vi.fn(async () => 'msg-1'),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/drive-disconnect-purge'),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDataLakeIdAny: h.connFindByDataLakeIdAny,
      markDisconnecting: h.connMarkDisconnecting,
      cancelDisconnect: h.connCancelDisconnect,
    },
    fabFileRepository: {
      ...actual.fabFileRepository,
      findByDriveConnectionIdInDataLake: h.fabFilesFindByDriveConnectionIdInDataLake,
      countByDriveConnectionIdInDataLake: h.fabFilesCountByDriveConnectionIdInDataLake,
    },
  };
});

import handler from '../drive-connection';

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => ({ json, send }));
  return { res: { json, send, status } as never, json, send, status };
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const makeReq = (method: string) =>
  ({ method, query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false }, logger }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/drive-connection (D2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:lake1' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.fabFilesCountByDriveConnectionIdInDataLake.mockResolvedValue(0);
    h.connMarkDisconnecting.mockResolvedValue(MARK);
    h.sendToQueue.mockResolvedValue('msg-1');
  });

  it('GET returns a credential-free connection view, with how many files it ingested', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
      enabled: true,
      oauthRefreshToken: 'SHOULD-NOT-LEAK',
    });
    h.fabFilesCountByDriveConnectionIdInDataLake.mockResolvedValue(5);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);

    const payload = json.mock.calls[0][0];
    expect(payload.connection).toMatchObject({
      id: 'conn1',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
      fileCount: 5,
    });
    expect(JSON.stringify(payload)).not.toContain('SHOULD-NOT-LEAK');
    expect(h.fabFilesCountByDriveConnectionIdInDataLake).toHaveBeenCalledWith('conn1', 'datalake:lake1');
  });

  it('GET reports a connection whose queued disconnect purge is still running', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      status: 'connected',
      enabled: false,
      disconnectRequestedAt: new Date(),
    });
    h.fabFilesCountByDriveConnectionIdInDataLake.mockResolvedValue(12);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json.mock.calls[0][0].connection).toMatchObject({
      disconnecting: true,
      disconnectStalled: false,
      fileCount: 12,
    });
  });

  it('GET flags a pending disconnect with no purge run for DRIVE_DISCONNECT_STALL_MS as stalled', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      status: 'connected',
      enabled: false,
      disconnectRequestedAt: STALE,
    });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json.mock.calls[0][0].connection).toMatchObject({ disconnecting: true, disconnectStalled: true });
  });

  // STALE (16 min) is for the disconnect window; the unchained sync-claim window is 20 min.
  const CLAIM_PAST_WINDOW = new Date(Date.now() - 21 * 60 * 1000);

  it.each([
    ['a syncing row whose claim is past the window', { status: 'syncing', syncClaimedAt: CLAIM_PAST_WINDOW }, true],
    ['a syncing row with a fresh claim', { status: 'syncing', syncClaimedAt: new Date() }, false],
    ['a syncing row with no claim stamp', { status: 'syncing' }, true],
    ['a connected row', { status: 'connected', syncClaimedAt: CLAIM_PAST_WINDOW }, false],
  ])('GET reports syncStale for %s', async (_name, overrides, syncStale) => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: true, ...overrides });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json.mock.calls[0][0].connection.syncStale).toBe(syncStale);
  });

  it('GET returns null when no connection feeds the lake', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json).toHaveBeenCalledWith({ connection: null });
  });

  it('DELETE marks the connection disconnecting, enqueues the purge, and 202s without purging inline', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: true });
    const calls: string[] = [];
    h.connMarkDisconnecting.mockImplementationOnce(async () => (calls.push('mark'), MARK));
    h.sendToQueue.mockImplementationOnce(async () => (calls.push('enqueue'), 'msg-1'));
    const { res, status, json } = makeRes();
    await run(makeReq('DELETE'), res);

    // Marked before enqueue: the consumer drops a message whose connection carries no pending mark.
    expect(calls).toEqual(['mark', 'enqueue']);
    // Scoped to the LAKE's org, never a caller-supplied one.
    expect(h.verifyOrgAccess).toHaveBeenCalledWith(expect.anything(), 'orgA');
    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.getSourceQueueUrl).toHaveBeenCalledWith('driveDisconnectPurgeQueue');
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/drive-disconnect-purge', {
      connectionId: 'conn1',
      dataLakeId: 'lake1',
      organizationId: 'orgA',
    });
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, queued: true });
    // File count no longer bounds the request: nothing is resolved or swept on the request path.
    expect(h.fabFilesFindByDriveConnectionIdInDataLake).not.toHaveBeenCalled();
  });

  it('DELETE rolls back its own mark, compare-and-set on the stamp it wrote, when the enqueue fails', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: true });
    h.sendToQueue.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow('SQS unavailable');
    expect(h.connCancelDisconnect).toHaveBeenCalledWith('conn1', 'orgA', MARK_STAMP, true);
  });

  it('DELETE restores the pre-mark enabled value (an archived lake stays disabled) on rollback', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: false });
    h.connMarkDisconnecting.mockResolvedValueOnce({ ...MARK, previousEnabled: false });
    h.sendToQueue.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow('SQS unavailable');
    expect(h.connCancelDisconnect).toHaveBeenCalledWith('conn1', 'orgA', MARK_STAMP, false);
  });

  it('DELETE skips the rollback when this call did not create the mark (a concurrent DELETE did)', async () => {
    // The snapshot read no pending disconnect, but another DELETE stamped the row first; its
    // message may have landed, so this one must not un-stamp it.
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: true });
    h.connMarkDisconnecting.mockResolvedValueOnce({ ...MARK, created: false });
    h.sendToQueue.mockRejectedValueOnce(new Error('SQS unavailable'));
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow('SQS unavailable');
    expect(h.connCancelDisconnect).not.toHaveBeenCalled();
  });

  it('DELETE surfaces the enqueue error when the rollback itself throws', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', enabled: true });
    h.sendToQueue.mockRejectedValueOnce(new Error('SQS unavailable'));
    h.connCancelDisconnect.mockRejectedValueOnce(new Error('mongo blip'));
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow('SQS unavailable');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('roll back'),
      expect.objectContaining({ error: 'mongo blip' })
    );
  });

  it('DELETE re-queues a stalled pending disconnect, so a purge that landed in the DLQ can be retried', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      enabled: false,
      disconnectRequestedAt: STALE,
    });
    h.connMarkDisconnecting.mockResolvedValueOnce({ ...MARK, created: false, previousEnabled: false });
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(202);
  });

  it('DELETE accepts but does not re-queue a pending disconnect whose purge ran recently', async () => {
    // A second message would start a parallel self-re-enqueueing chain over the same files.
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      enabled: false,
      disconnectRequestedAt: new Date(),
    });
    const { res, status, json } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connMarkDisconnecting).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, queued: false });
  });

  it('DELETE 204s when there is nothing to release', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connMarkDisconnecting).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(204);
  });

  it('DELETE 409s (does NOT mark or enqueue) while a sync is in progress', async () => {
    // markDisconnecting is the atomic compare-and-set that answers this - not a snapshot read of
    // `conn.status`, which a concurrent claimForSync could race between the read and a bare disable.
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', status: 'syncing' });
    h.connMarkDisconnecting.mockResolvedValue(null);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', 'orgA');
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(409);
  });

  /**
   * The disabled-connection cases. Archiving or soft-deleting a lake flips its connection to
   * `enabled: false`, which is why this route resolves through the enabled-BLIND finder: an
   * enabled-only lookup would report the connection gone while the Google grant stayed live and the
   * globally-unique driveFolderId claim stayed held, so the folder could never be re-claimed by
   * anyone and this endpoint would answer 204 having revoked nothing.
   */
  it('DELETE still queues the revoking purge for an archived lake whose connection is disabled', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      enabled: false,
      status: 'connected',
    });
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.sendToQueue).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ connectionId: 'conn1' }));
    expect(status).toHaveBeenCalledWith(202);
  });

  it('GET reports a disabled connection rather than pretending it is gone', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      driveFolderId: 'Folder123',
      status: 'connected',
      enabled: false,
    });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json.mock.calls[0][0].connection).toMatchObject({ id: 'conn1', enabled: false });
  });

  // Both verbs, because that check is the ONLY thing scoping a deliberately-global finder: with one
  // arm untested it could be dropped from the other for free.
  it.each(['GET', 'DELETE'] as const)(
    '%s 404s a connection whose org does not match the lake, since the finder is global',
    async method => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgB' });
      const { res } = makeRes();
      await expect(run(makeReq(method), res)).rejects.toThrow(/not found/i);
      expect(h.sendToQueue).not.toHaveBeenCalled();
    }
  );

  it('denies a caller who is not an org owner/manager', async () => {
    h.verifyOrgAccess.mockRejectedValue(new Error('Organization not found'));
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/organization not found/i);
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('GET resolves a null connection for a personal (org-less) lake, rather than 404ing', async () => {
    // A personal lake genuinely has no connection to report - that's "no connection", not a
    // failure, so the client needs to be able to tell it apart from a denied/missing-lake read.
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json).toHaveBeenCalledWith({ connection: null });
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('DELETE 404s a personal (org-less) lake', async () => {
    // DELETE goes through resolveOrgLake, the one path GET no longer exercises since it inlined
    // its own org-less short-circuit - so this is the only remaining coverage of that guard.
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('GET 404s when the lake itself does not exist', async () => {
    h.dlFindById.mockResolvedValue(null);
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });
});

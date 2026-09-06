// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeRebuildAccess: vi.fn(),
  computeLakeMemoryHealth: vi.fn(),
  getSettingsValue: vi.fn(),
  tryIncrementWithinLimitFixedWindow: vi.fn(),
  setLakeMemoryCursor: vi.fn(),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/lake-memory'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  logAuditEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeRebuildAccess: h.assertLakeRebuildAccess,
    computeLakeMemoryHealth: h.computeLakeMemoryHealth,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { setLakeMemoryCursor: h.setLakeMemoryCursor },
  dataLakeAccessGrantRepository: {},
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrementWithinLimitFixedWindow },
  memoryLedgerRepository: {},
}));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return actual;
});
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));
vi.mock('@server/utils/auditLog', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, logAuditEvent: h.logAuditEvent };
});

import handler from '../lake-memory';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const invoke = async (method: 'GET' | 'POST', body: unknown = {}) => {
  const { res, json } = makeRes();
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method, query: { id: 'lake1' }, body, user: { id: 'u1' }, apiKeyInfo: undefined, logger: undefined } as never,
    res
  );
  return { res, json };
};

const lake = {
  id: 'lakeDoc1',
  datalakeTag: 'datalake:acme',
  createdByUserId: 'u1',
  lakeMemoryEnabled: true,
  lakeMemoryExtractionAt: null,
  lakeMemoryCursor: null,
  lastSyncAt: null,
};

const health = {
  state: 'current',
  lastBuiltAt: '2026-09-01T00:00:00.000Z',
  factCount: 12,
  sourceDocumentCount: 3,
  memberCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(lake);
  h.assertLakeRebuildAccess.mockResolvedValue(lake);
  h.computeLakeMemoryHealth.mockResolvedValue(health);
  h.getSettingsValue.mockResolvedValue(true);
  h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true });
  h.setLakeMemoryCursor.mockResolvedValue(undefined);
  h.sendToQueue.mockResolvedValue(undefined);
  h.logAuditEvent.mockResolvedValue(undefined);
});

describe('GET /api/data-lakes/[id]/lake-memory', () => {
  it('returns the build door state without mutating anything', async () => {
    const { json } = await invoke('GET');
    expect(json).toHaveBeenCalledWith(health);
    expect(h.assertLakeAccess).toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.setLakeMemoryCursor).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/[id]/lake-memory', () => {
  it('queues a manual rebuild, clears the continuation cursor, and audits the trigger', async () => {
    const { res, json } = await invoke('POST');

    expect(h.assertLakeRebuildAccess).toHaveBeenCalled();
    expect(h.setLakeMemoryCursor).toHaveBeenCalledWith('lakeDoc1', null);
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith(
      'https://sqs.example.com/lake-memory',
      expect.objectContaining({ dataLakeId: 'lakeDoc1', userId: 'u1', slice: 0 })
    );
    expect(h.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.logAuditEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        userId: 'u1',
        action: 'LAKE_MEMORY_BUILD_TRIGGERED',
        metadata: expect.objectContaining({ dataLakeId: 'lakeDoc1' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ ok: true, queued: true });
  });

  it('refuses with 409 when the platform flag is off, and never mutates the lake', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    await expect(invoke('POST')).rejects.toThrow(/disabled platform-wide/);
    expect(h.setLakeMemoryCursor).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('refuses with 422 when the lake itself has not opted in', async () => {
    h.assertLakeRebuildAccess.mockResolvedValue({ ...lake, lakeMemoryEnabled: false });
    await expect(invoke('POST')).rejects.toThrow(/not enabled for this lake/);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses with 409 when a build is already running (lease held)', async () => {
    h.assertLakeRebuildAccess.mockResolvedValue({ ...lake, lakeMemoryExtractionAt: new Date() });
    await expect(invoke('POST')).rejects.toThrow(/already running/);
    expect(h.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses with 429 when the per-lake daily cap is exhausted, sharing the same bucket as the automatic path', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: false });
    await expect(invoke('POST')).rejects.toThrow(/Daily lake memory build limit/);
    expect(h.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:lakeDoc1:data-lakes/lake-memory-extraction',
      6,
      24 * 60 * 60 * 1000
    );
    expect(h.setLakeMemoryCursor).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('gates on rebuild access - a rejected assert never checks preconditions or enqueues', async () => {
    h.assertLakeRebuildAccess.mockRejectedValue(
      new Error("You do not have permission to rebuild this data lake's passages")
    );
    await expect(invoke('POST')).rejects.toThrow(/permission to rebuild/);
    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

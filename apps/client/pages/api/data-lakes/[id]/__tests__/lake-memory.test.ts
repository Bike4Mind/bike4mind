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

/**
 * A minimal express-ish chain. `use` middlewares RUN, in order, with a real `next` - the per-caller
 * rate-limit brake is mounted there and is method-scoped, so a fake that discarded `use` would report
 * it as present while never once executing it. A middleware that calls `next(err)` short-circuits, as
 * express does, and the error surfaces to the caller (the tests assert on it).
 */
type Mw = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Mw[] = [];
    const run = async (req: { method?: string }, res: unknown) => {
      for (const mw of middlewares) {
        let failure: unknown;
        let advanced = false;
        await mw(req, res, (err?: unknown) => {
          advanced = true;
          failure = err;
        });
        if (failure) throw failure;
        if (!advanced) return;
      }
      return routes[req.method ?? 'POST']?.(req, res);
    };
    const chain = Object.assign(run, {
      use: (mw: Mw) => (middlewares.push(mw), chain),
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
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
  const res = { json, status: vi.fn(() => ({ json })), setHeader: vi.fn() } as never;
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

/**
 * Two DIFFERENT buckets share one counter primitive, so every assertion here names the key it means.
 * `LAKE_CAP_KEY` is the per-lake daily build cap, incremented inside the POST handler and shared with
 * the automatic batch-finalize trigger. `CALLER_CAP_KEY` is the per-caller brake mounted as
 * middleware, which bounds one operator looping the button across many lakes.
 */
const LAKE_CAP_KEY = 'rate-limit:lakeDoc1:data-lakes/lake-memory-extraction';
const CALLER_CAP_KEY = 'rate-limit:u1:data-lakes/lake-memory';
const capCalls = (key: string) => h.tryIncrementWithinLimitFixedWindow.mock.calls.filter(c => c[0] === key);

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
  h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 1000) });
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
    // The caller brake is POST-scoped: this GET is the state poll the manager panel drives while a
    // build runs, and metering it would throttle READING state rather than starting work.
    expect(h.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/[id]/lake-memory', () => {
  /**
   * The restart is asked for, not performed here. The door used to clear the cursor itself and then
   * enqueue, which opened a window with two distinct failures: the health door reads `building` from a
   * lease OR a non-null cursor, so a cleared cursor made an in-flight build look idle; and an enqueue
   * that failed after the clear discarded a continuation's position with nothing queued to redo it.
   * `restart: true` moves the clear inside the run, under the lease that serializes it.
   */
  it('queues a manual rebuild with restart set, and clears no cursor of its own', async () => {
    const { res, json } = await invoke('POST');

    expect(h.assertLakeRebuildAccess).toHaveBeenCalled();
    expect(h.setLakeMemoryCursor).not.toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith(
      'https://sqs.example.com/lake-memory',
      expect.objectContaining({ dataLakeId: 'lakeDoc1', userId: 'u1', slice: 0, restart: true })
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
    // The per-lake cap is not spent on a refusal. The per-caller brake IS - it is middleware and runs
    // ahead of the handler, which is deliberate: a loop against a disabled flag is still a loop.
    expect(capCalls(LAKE_CAP_KEY)).toHaveLength(0);
  });

  it('refuses with 422 when the lake itself has not opted in', async () => {
    h.assertLakeRebuildAccess.mockResolvedValue({ ...lake, lakeMemoryEnabled: false });
    await expect(invoke('POST')).rejects.toThrow(/not enabled for this lake/);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses with 409 when a build is already running (lease held)', async () => {
    h.assertLakeRebuildAccess.mockResolvedValue({ ...lake, lakeMemoryExtractionAt: new Date() });
    await expect(invoke('POST')).rejects.toThrow(/already running/);
    expect(capCalls(LAKE_CAP_KEY)).toHaveLength(0);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses with 429 when the per-lake daily cap is exhausted, sharing the same bucket as the automatic path', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: key !== LAKE_CAP_KEY,
      expiresAt: new Date(Date.now() + 1000),
    }));
    await expect(invoke('POST')).rejects.toThrow(/Daily lake memory build limit/);
    expect(h.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(LAKE_CAP_KEY, 6, 24 * 60 * 60 * 1000);
    expect(h.setLakeMemoryCursor).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  /**
   * The per-lake cap bounds one lake and the automatic trigger shares its bucket, so it does nothing
   * about an operator looping the button across many lakes - each fresh lake starts with a full
   * allowance, and a build chain is the most expensive thing this subsystem does. This brake meters
   * the CALLER, across lakes, and is not exempted for admins: the operator most able to loop it is
   * exactly the one it has to bound.
   */
  it('brakes the caller across lakes, in its own bucket, at four lakes worth of the per-lake cap', async () => {
    await invoke('POST');

    expect(h.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(CALLER_CAP_KEY, 24, 24 * 60 * 60 * 1000);
    // Distinct keys, so the two never consume each other's allowance.
    expect(capCalls(LAKE_CAP_KEY)).toHaveLength(1);
    expect(capCalls(CALLER_CAP_KEY)).toHaveLength(1);
  });

  it('refuses before any work when the caller brake is exhausted', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockImplementation(async (key: string) => ({
      success: key !== CALLER_CAP_KEY,
      expiresAt: new Date(Date.now() + 1000),
    }));

    await expect(invoke('POST')).rejects.toThrow(/Rate limit exceeded/);
    // Middleware, so nothing downstream runs - not the gate, not the per-lake cap, not the enqueue.
    expect(h.assertLakeRebuildAccess).not.toHaveBeenCalled();
    expect(capCalls(LAKE_CAP_KEY)).toHaveLength(0);
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

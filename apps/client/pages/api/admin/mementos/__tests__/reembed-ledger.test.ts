// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Wrap handlers so thrown HTTPErrors become JSON responses, matching production baseApi behaviour.
function wrapHandler(fn: (req: unknown, res: any) => Promise<unknown>) {
  return async (req: unknown, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      res.status(e?.statusCode ?? 500).json({ error: e?.message ?? 'Internal server error' });
    }
  };
}

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const mock: { _post?: (req: unknown, res: unknown) => Promise<unknown>; post: (fn: unknown) => typeof mock } = {
      post: function (fn: unknown) {
        mock._post = wrapHandler(fn as (req: unknown, res: unknown) => Promise<unknown>);
        return mock;
      },
    };
    return mock;
  },
}));

const listPrincipals = vi.fn();
vi.mock('@bike4mind/database', () => ({
  MEMORY_PRINCIPAL_KINDS: ['user', 'agent', 'org', 'system', 'lake'],
  memoryLedgerRepository: { listPrincipalsNeedingVectors: (...a: unknown[]) => listPrincipals(...a) },
}));

const migrateMock = vi.fn();
vi.mock('@server/memory/reembedMementos', () => ({
  migrateLedgerVectorsForPrincipal: (...a: unknown[]) => migrateMock(...a),
}));

import handler from '../reembed-ledger';

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = user;
  return { req: req as any, res: res as any };
}

const stats = (over: Record<string, unknown> = {}) => ({
  total: 0,
  alreadyCurrent: 0,
  truncated: 0,
  reembedded: 0,
  backfilled: 0,
  noFact: 0,
  failed: 0,
  stoppedAtLimit: false,
  errors: [],
  ...over,
});
const p = (id: string) => ({ principalKind: 'lake', principalId: id, ownerUserId: 'o1' });

async function post(body: Record<string, unknown>) {
  const { req, res } = makeReq(body);
  await (handler as any)._post(req, res);
  return res;
}

describe('/api/admin/mementos/reembed-ledger', () => {
  beforeEach(() => {
    listPrincipals.mockReset();
    migrateMock.mockReset();
    listPrincipals.mockResolvedValue([]);
    migrateMock.mockResolvedValue(stats());
  });

  it('returns 403 for non-admin', async () => {
    const { req, res } = makeReq({}, { id: 'u-1', isAdmin: false });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(listPrincipals).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor', async () => {
    const res = await post({ after: { principalKind: 'bogus', principalId: 'x', ownerUserId: 'y' } });
    expect(res._getStatusCode()).toBe(400);
  });

  it('accepts the null nextAfter a first page returns as a fresh walk', async () => {
    const res = await post({ after: null });
    expect(res._getStatusCode()).toBe(200);
    expect(listPrincipals).toHaveBeenCalledWith(expect.any(String), { after: undefined, limit: 25 });
  });

  it('answers an empty page with the full shape and hasMore false', async () => {
    const data = (await post({}))._getJSONData();
    expect(data).toMatchObject({
      processedPrincipals: 0,
      dryRun: true,
      backfilled: 0,
      hasMore: false,
      nextAfter: null,
    });
  });

  it('dry-runs by default, unbounded, and passes the cursor to the query', async () => {
    listPrincipals.mockResolvedValue([p('a')]);
    migrateMock.mockResolvedValue(stats({ backfilled: 500 }));

    const data = (await post({ after: p('0') }))._getJSONData();

    expect(listPrincipals).toHaveBeenCalledWith(expect.any(String), { after: p('0'), limit: 25 });
    expect(migrateMock).toHaveBeenCalledWith(
      { principal: { kind: 'lake', id: 'a' }, ownerUserId: 'o1' },
      { dryRun: true }
    );
    expect(data).toMatchObject({ dryRun: true, backfilled: 500, hasMore: false, nextAfter: p('a') });
  });

  it('reports hasMore with the last principal as cursor on a full page', async () => {
    listPrincipals.mockResolvedValue(Array.from({ length: 25 }, (_, i) => p(`l${String(i).padStart(2, '0')}`)));

    const data = (await post({ execute: true }))._getJSONData();

    expect(data).toMatchObject({ processedPrincipals: 25, hasMore: true, nextAfter: p('l24') });
  });

  it('resumes a principal the budget cut short after progress by leaving the cursor before it', async () => {
    listPrincipals.mockResolvedValue([p('a'), p('b'), p('c')]);
    migrateMock
      .mockResolvedValueOnce(stats({ backfilled: 40 }))
      .mockResolvedValueOnce(stats({ backfilled: 60, stoppedAtLimit: true }));

    const data = (await post({ execute: true }))._getJSONData();

    expect(migrateMock.mock.calls[1][1]).toEqual({ limit: 60 });
    expect(migrateMock).toHaveBeenCalledTimes(2);
    expect(data).toMatchObject({ processedPrincipals: 2, hasMore: true, nextAfter: p('a') });
  });

  it('passes over a principal that made no progress within the budget so it cannot block the rest', async () => {
    listPrincipals.mockResolvedValue([p('a'), p('b')]);
    migrateMock
      .mockResolvedValueOnce(stats({ failed: 100, stoppedAtLimit: true, errors: ['owner o1: no key'] }))
      .mockResolvedValueOnce(stats());

    const data = (await post({ execute: true }))._getJSONData();

    expect(data.failedPrincipals).toEqual([
      { ...p('a'), error: 'no progress within provider budget: owner o1: no key' },
    ]);
    expect(data).toMatchObject({ hasMore: true, nextAfter: p('a') });
  });

  it('records a throwing principal and keeps processing the page', async () => {
    listPrincipals.mockResolvedValue([p('a'), p('b')]);
    migrateMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(stats({ backfilled: 1 }));

    const data = (await post({ execute: true }))._getJSONData();

    expect(data.failedPrincipals).toEqual([{ ...p('a'), error: 'boom' }]);
    expect(data).toMatchObject({ backfilled: 1, processedPrincipals: 2, nextAfter: p('b') });
  });

  it('caps the failedEvents sample at 50 while failed keeps the true count', async () => {
    listPrincipals.mockResolvedValue([p('a')]);
    migrateMock.mockResolvedValue(stats({ failed: 80, errors: Array.from({ length: 80 }, (_, i) => `event ${i}`) }));

    const data = (await post({ execute: true }))._getJSONData();

    expect(data.failed).toBe(80);
    expect(data.failedEvents).toHaveLength(50);
  });
});

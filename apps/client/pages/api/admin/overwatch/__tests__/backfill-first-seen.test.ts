// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Wrap handlers so thrown HTTPErrors become JSON responses, matching production baseApi behaviour.
function wrapHandler(fn: (req: unknown, res: any) => Promise<unknown>) {
  return async (req: unknown, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      const code = e?.statusCode ?? 500;
      res.status(code).json({ error: e?.message ?? 'Internal server error' });
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

// User.find(...).sort().skip().limit().lean() - chainable query that resolves to the staged docs.
let usersBatch: Array<{ _id: { toString: () => string }; createdAt: unknown }> = [];
const mockLean = vi.fn(() => Promise.resolve(usersBatch));
const mockFind = vi.fn((..._a: unknown[]) => ({
  sort: () => ({ skip: () => ({ limit: () => ({ lean: mockLean }) }) }),
}));
const mockBulkWrite = vi.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });

// Deferred wrappers (not direct references): the vi.mock factory is hoisted above these
// const declarations, so a direct `find: mockFind` would hit the temporal dead zone at
// hoist time. The arrow wrapper defers access to call time. The rest param on mockFind's
// impl lets the spread type-check (TS2556).
vi.mock('@bike4mind/database', () => ({
  User: { find: (...a: unknown[]) => mockFind(...a) },
  OverwatchUserFirstSeen: { bulkWrite: (...a: unknown[]) => mockBulkWrite(...a) },
}));

vi.mock('@server/analytics/pseudonymize', () => ({
  pseudonymizeUserId: (id: string) => `pseudo:${id}`,
}));

vi.mock('@server/utils/config', () => ({
  Config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' },
}));

import handler from '../backfill-first-seen';
import { Config } from '@server/utils/config';

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = user;
  (req as any).logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  return { req: req as any, res: res as any };
}

function doc(id: string, createdAt: unknown) {
  return { _id: { toString: () => id }, createdAt };
}

describe('/api/admin/overwatch/backfill-first-seen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usersBatch = [];
    mockBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
    (Config as Record<string, string>).OVERWATCH_PSEUDONYM_SALT = 'test-salt';
  });

  it('returns 403 for non-admin', async () => {
    const { req, res } = makeReq({}, { id: 'u-1', isAdmin: false });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns 503 when OVERWATCH_PSEUDONYM_SALT is not configured', async () => {
    (Config as Record<string, string>).OVERWATCH_PSEUDONYM_SALT = 'not-configured';
    const { req, res } = makeReq();
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns processed=0, hasMore=false for an empty batch', async () => {
    usersBatch = [];
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ processed: 0, hasMore: false });
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it('builds $min upsert ops and reports counts', async () => {
    usersBatch = [doc('a', new Date('2026-01-15T10:00:00Z')), doc('b', '2026-02-20T00:00:00Z')];
    mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 });
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ processed: 2, skipped: 0, upserted: 2, hasMore: false, nextSkip: 2 });

    const ops = mockBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.filter).toEqual({ productId: 'bike4mind', userId: 'pseudo:a' });
    expect(ops[0].updateOne.update.$min).toEqual({ firstSeenDate: '2026-01-15' });
    expect(ops[0].updateOne.upsert).toBe(true);
  });

  it('skips docs with a missing/unparseable createdAt instead of throwing', async () => {
    usersBatch = [doc('good', new Date('2026-01-15T10:00:00Z')), doc('nodate', undefined), doc('bad', 'not-a-date')];
    mockBulkWrite.mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ processed: 3, skipped: 2 });
    const ops = mockBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.filter.userId).toBe('pseudo:good');
  });
});

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

let userIdPage: Array<{ _id: string }> = [];
const mockAggregate = vi.fn(() => Promise.resolve(userIdPage));

vi.mock('@bike4mind/database', () => ({
  Memento: { aggregate: (...a: unknown[]) => mockAggregate(...a) },
}));

const reembedMock = vi.fn();
vi.mock('@server/memory/reembedMementos', () => ({
  reembedMementosForUser: (...a: unknown[]) => reembedMock(...a),
}));

import handler from '../reembed';

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = user;
  (req as any).logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  return { req: req as any, res: res as any };
}

const emptyStats = { total: 0, alreadyCurrent: 0, reembedded: 0, failed: 0, skippedEmpty: 0 };

describe('/api/admin/mementos/reembed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userIdPage = [];
    reembedMock.mockResolvedValue(emptyStats);
  });

  it('returns 403 for non-admin', async () => {
    const { req, res } = makeReq({}, { id: 'u-1', isAdmin: false });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it('returns processedUsers=0, hasMore=false for an empty page', async () => {
    userIdPage = [];
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ processedUsers: 0, hasMore: false });
    expect(reembedMock).not.toHaveBeenCalled();
  });

  it('defaults to a dry run', async () => {
    userIdPage = [{ _id: 'u1' }];
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(reembedMock).toHaveBeenCalledWith('u1', { dryRun: true });
    expect(res._getJSONData()).toMatchObject({ dryRun: true });
  });

  it('passes dryRun:false only when execute is explicitly true', async () => {
    userIdPage = [{ _id: 'u1' }];
    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);
    expect(reembedMock).toHaveBeenCalledWith('u1', { dryRun: false });
  });

  it('sums per-user stats across the page and reports pagination', async () => {
    userIdPage = [{ _id: 'u1' }, { _id: 'u2' }];
    reembedMock
      .mockResolvedValueOnce({ total: 5, alreadyCurrent: 1, reembedded: 3, failed: 1, skippedEmpty: 0 })
      .mockResolvedValueOnce({ total: 2, alreadyCurrent: 0, reembedded: 2, failed: 0, skippedEmpty: 0 });

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      processedUsers: 2,
      total: 7,
      alreadyCurrent: 1,
      reembedded: 5,
      failed: 1,
      skippedEmpty: 0,
      failedUsers: [],
      hasMore: false,
      nextSkip: 2,
    });
  });

  it('isolates a per-user failure so the rest of the page still completes', async () => {
    userIdPage = [{ _id: 'bad-user' }, { _id: 'good-user' }];
    reembedMock
      .mockRejectedValueOnce(new Error('OpenAI API key required to re-embed memory, but none is available'))
      .mockResolvedValueOnce({ total: 4, alreadyCurrent: 0, reembedded: 4, failed: 0, skippedEmpty: 0 });

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.processedUsers).toBe(2);
    expect(body.reembedded).toBe(4);
    expect(body.failedUsers).toEqual([
      { userId: 'bad-user', error: 'OpenAI API key required to re-embed memory, but none is available' },
    ]);
  });
});

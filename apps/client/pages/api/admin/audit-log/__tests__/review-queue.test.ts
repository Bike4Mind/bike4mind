import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockListReviewQueue } = vi.hoisted(() => ({ mockListReviewQueue: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { listReviewQueue: (...a: unknown[]) => mockListReviewQueue(...a) },
}));

import handler from '../review-queue';
import { decodeAuditCursor } from '@server/utils/adminAuditQuery';

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const configOf = () => (handler as unknown as { _config?: { auth?: unknown; requiredScopes?: string[] } })._config;

const CURSOR_ID = 'a'.repeat(24);

beforeEach(() => {
  mockListReviewQueue.mockReset().mockResolvedValue({ entries: [], nextCursor: null, total: 0 });
});

describe('GET /api/admin/audit-log/review-queue', () => {
  it('refuses API keys: jwtOnly and no requiredScopes', () => {
    expect(configOf()?.auth).toBe('jwtOnly');
    expect(configOf()?.requiredScopes).toBeUndefined();
  });

  it('rejects a user without admin access with 403', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('defaults to unreviewed with limit 25 and the caller as viewer', async () => {
    const { res, promise } = call();
    await promise;

    expect(mockListReviewQueue).toHaveBeenCalledWith(
      { status: 'unreviewed', from: undefined, viewerUserId: 'admin1' },
      { limit: 25, cursor: undefined }
    );
    expect(res._getJSONData()).toEqual({ entries: [], nextCursor: null, total: 0 });
  });

  it('uses the impersonating admin as the viewer', async () => {
    await call({}, { id: 'target', isAdmin: true, impersonatedBy: 'real-admin' }).promise;

    expect(mockListReviewQueue.mock.calls[0]?.[0]).toMatchObject({ viewerUserId: 'real-admin' });
  });

  it('rejects status all without from', async () => {
    await expect(call({ status: 'all' }).promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mockListReviewQueue).not.toHaveBeenCalled();
  });

  it('rejects status all with an invalid from', async () => {
    await expect(call({ status: 'all', from: 'yesterday' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown status', async () => {
    await expect(call({ status: 'done' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes from for status all', async () => {
    await call({ status: 'all', from: '2026-10-01T00:00:00.000Z' }).promise;

    expect(mockListReviewQueue.mock.calls[0]?.[0]).toMatchObject({
      status: 'all',
      from: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('clamps limit to 100', async () => {
    await call({ limit: '500' }).promise;

    expect(mockListReviewQueue.mock.calls[0]?.[1]).toMatchObject({ limit: 100 });
  });

  it('rejects a malformed cursor', async () => {
    await expect(call({ cursor: 'not-a-cursor' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('encodes the next cursor and returns total', async () => {
    const occurredAt = new Date('2026-10-01T00:00:00.000Z');
    mockListReviewQueue.mockResolvedValue({ entries: [], nextCursor: { occurredAt, id: CURSOR_ID }, total: 42 });

    const { res, promise } = call();
    await promise;

    const body = res._getJSONData() as { nextCursor: string; total: number };
    expect(body.total).toBe(42);
    expect(decodeAuditCursor(body.nextCursor)).toEqual({ occurredAt, id: CURSOR_ID });
  });
});

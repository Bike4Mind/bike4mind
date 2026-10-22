import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { encodeAuditCursor } from '@server/utils/adminAuditQuery';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { list: (...a: unknown[]) => mockList(...a) },
}));

import handler from '../index';

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const scopesOf = () => (handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes;

const cursorFor = (occurredAt: Date, id: string) => encodeAuditCursor({ occurredAt, id });
const OBJECT_ID = 'a'.repeat(24);

beforeEach(() => {
  mockList.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
});

describe('GET /api/admin/audit-log', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect(scopesOf()).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin with 403', async () => {
    const { promise } = call({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('passes parsed filters, clamped limit and decoded cursor to list', async () => {
    const occurredAt = new Date('2026-09-01T00:00:00.000Z');
    const { res, promise } = call({
      category: 'credits',
      actorUserId: 'user-1',
      limit: '500',
      cursor: cursorFor(occurredAt, OBJECT_ID),
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockList).toHaveBeenCalledWith(
      { category: 'credits', actorUserId: 'user-1' },
      { limit: 100, cursor: { occurredAt, id: OBJECT_ID } }
    );
  });

  it('defaults the limit to 50 and clamps below to 1', async () => {
    await call().promise;
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 50, cursor: undefined });
    await call({ limit: '0' }).promise;
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 1, cursor: undefined });
  });

  it('returns 400 for a non-numeric limit', async () => {
    await expect(call({ limit: 'abc' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for a repeated query parameter', async () => {
    await expect(call({ category: ['credits', 'access'] }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for an invalid filter value', async () => {
    await expect(call({ severity: 'loud' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for an undecodable cursor', async () => {
    await expect(call({ cursor: 'not-a-cursor' }).promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('encodes nextCursor', async () => {
    const occurredAt = new Date('2026-08-01T12:00:00.000Z');
    mockList.mockResolvedValue({ entries: [{ id: OBJECT_ID }], nextCursor: { occurredAt, id: OBJECT_ID } });
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData()).toEqual({
      entries: [{ id: OBJECT_ID }],
      nextCursor: cursorFor(occurredAt, OBJECT_ID),
    });
  });
});

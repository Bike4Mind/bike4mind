import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockSummarize } = vi.hoisted(() => ({ mockSummarize: vi.fn() }));

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
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { summarize: (...a: unknown[]) => mockSummarize(...a) },
}));

import handler from '../summary';

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const scopesOf = () => (handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes;

const NOW = new Date('2026-10-19T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTS = {
  creditGrants: { count: 2, topGranters: [] },
  permissionChanges: 1,
  impersonations: 0,
  deletions: 0,
  deniedAttempts: 3,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockSummarize.mockReset().mockResolvedValue(COUNTS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/admin/audit-log/summary', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect(scopesOf()).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin with 403', async () => {
    const { promise } = call({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('defaults to a 30-day window', async () => {
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData()).toMatchObject({ windowDays: 30, ...COUNTS });
  });

  it('rejects window=14', async () => {
    await expect(call({ window: '14' }).promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it.each([7, 30, 90])('passes since = now - %i days', async days => {
    const { res, promise } = call({ window: String(days) });
    await promise;

    const since = new Date(NOW.getTime() - days * DAY_MS);
    expect(mockSummarize).toHaveBeenCalledWith(since);
    expect(res._getJSONData()).toMatchObject({ windowDays: days, since: since.toISOString() });
  });
});

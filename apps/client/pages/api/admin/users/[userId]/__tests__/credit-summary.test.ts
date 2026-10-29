import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({ summarize: vi.fn(), latestTopUp: vi.fn(), findUser: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => handlers[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((handlers.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/database', () => ({
  AI_SPEND_DAILY_WINDOW_DAYS: 90,
  creditTransactionRepository: { summarizeAiSpend: h.summarize, findLatestTopUp: h.latestTopUp },
  userRepository: { findById: h.findUser },
}));

import handler from '../credit-summary';

const ADMIN = { id: 'admin1', isAdmin: true };

const run = (query: Record<string, string> = {}, user: unknown = ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1', ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  vi.resetAllMocks();
  h.findUser.mockImplementation(async (id: string) => (id === 'u1' ? { id: 'u1', currentCredits: 321 } : null));
  h.summarize.mockResolvedValue({
    spent: { last24h: 1, last7d: 2, last30d: 3 },
    topModel30d: { model: 'm-a', credits: 3 },
    dailyCredits: [
      { day: '2026-06-15', credits: 1 },
      { day: '2026-06-10', credits: 2 },
    ],
    byModel: [
      { key: 'm-a', last7d: 2, last30d: 3, last90d: 3 },
      { key: null, last7d: 0, last30d: 0, last90d: 1 },
    ],
    bySource: [{ key: 'web', last7d: 2, last30d: 3, last90d: 4 }],
  });
  h.latestTopUp.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/admin/users/[userId]/credit-summary', () => {
  it('requires the ADMIN scope and rejects non-admins and bad users before any read', async () => {
    expect((handler as unknown as { _config?: unknown })._config).toEqual({ auth: 'jwtOnly' });
    await expect(run({}, { id: 'u2', isAdmin: false }).promise).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run({ userId: '' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ userId: 'ghost' }).promise).rejects.toBeInstanceOf(NotFoundError);
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('combines balance, spend, top model and a 90-day zero-filled series ending today', async () => {
    const { res, promise } = run();
    await promise;

    const body = res._getJSONData();
    expect(body).toMatchObject({
      balance: 321,
      spent: { last24h: 1, last7d: 2, last30d: 3 },
      topModel30d: { model: 'm-a', credits: 3 },
      lastTopUp: null,
    });
    expect(body.daily).toHaveLength(90);
    expect(body.daily[0]).toEqual({ date: '2026-03-18', credits: 0 });
    expect(body.daily[89]).toEqual({ date: '2026-06-15', credits: 1 });
    expect(body.daily.find((d: { date: string }) => d.date === '2026-06-10')).toEqual({
      date: '2026-06-10',
      credits: 2,
    });
    expect(h.summarize).toHaveBeenCalledExactlyOnceWith('u1', 'User', new Date('2026-06-15T12:00:00Z'));
  });

  it('reports the last top-up with an unsigned amount', async () => {
    h.latestTopUp.mockResolvedValue({ type: 'purchase', credits: -250, createdAt: new Date('2026-06-01T00:00:00Z') });
    const { res, promise } = run();
    await promise;
    expect(res._getJSONData().lastTopUp).toEqual({ at: '2026-06-01T00:00:00.000Z', credits: 250, type: 'purchase' });
  });

  it('passes the per-model and per-source spend buckets through, unknown model included', async () => {
    const { res, promise } = run();
    await promise;

    const body = res._getJSONData();
    expect(body.byModel).toEqual([
      { key: 'm-a', last7d: 2, last30d: 3, last90d: 3 },
      { key: null, last7d: 0, last30d: 0, last90d: 1 },
    ]);
    expect(body.bySource).toEqual([{ key: 'web', last7d: 2, last30d: 3, last90d: 4 }]);
  });
});

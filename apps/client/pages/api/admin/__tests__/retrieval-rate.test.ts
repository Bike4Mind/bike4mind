import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind } = vi.hoisted(() => ({ mockFind: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  Quest: { find: (...a: unknown[]) => mockFind(...a) },
}));

import handler from '../retrieval-rate';

const TIMESTAMP = new Date('2026-08-20T00:00:00.000Z');

const row = (retrieval: Record<string, unknown> | undefined) => ({
  timestamp: TIMESTAMP,
  promptMeta: retrieval ? { retrieval } : {},
});

const questChain = (rows: unknown[]) => ({
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(rows),
});

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

const run = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = logger;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const findQuery = () => mockFind.mock.calls[0][0] as Record<string, unknown>;
const body = (res: ReturnType<typeof createMocks>['res']) => JSON.parse(res._getData());

beforeEach(() => {
  mockFind.mockReset().mockReturnValue(questChain([]));
  logger.warn.mockReset();
});

describe('GET /api/admin/retrieval-rate', () => {
  it('rejects non-admin callers', async () => {
    const { promise } = run({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toThrow(/Admin access required/);
  });

  it('scopes the population to turns that carry a retrieval record', async () => {
    const { promise } = run();
    await promise;
    expect(findQuery()['promptMeta.retrieval']).toEqual({ $exists: true });
    expect(findQuery().timestamp).toBeUndefined();
  });

  it('applies both date bounds when given', async () => {
    const { promise } = run({ startDate: '2026-08-01', endDate: '2026-08-31' });
    await promise;
    expect(findQuery().timestamp).toEqual({
      $gte: new Date('2026-08-01'),
      $lte: new Date('2026-08-31'),
    });
  });

  it('rejects an unparseable bound instead of silently widening to all time', async () => {
    // The failure mode this guards: a mistyped date dropping the filter, so the response reports a
    // real number for a window nobody asked for and the caller cannot tell.
    const { promise } = run({ startDate: 'last-tuesday' });
    await expect(promise).rejects.toThrow(/not a parseable date/);
  });

  it('reports the rate over the folded turns', async () => {
    mockFind.mockReturnValue(
      questChain([
        row({ attempted: true, mode: 'optional' }),
        row({ attempted: false, mode: 'optional' }),
        row({ attempted: true, mode: 'forced' }),
        row({ attempted: false, mode: 'forced', forcedSkipReason: 'attached_files' }),
      ])
    );
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(body(res).summary).toMatchObject({
      offeredTurns: 2,
      retrievedTurns: 1,
      rate: 0.5,
      forcedTurns: 1,
      forcedSuppressed: { turns: 1, retrievedTurns: 0 },
    });
    expect(body(res).turnsScanned).toBe(4);
    expect(body(res).truncated).toBe(false);
  });

  it('projects only the three fields the fold reads, leaving dataLakeTags in the database', async () => {
    const chain = questChain([]);
    mockFind.mockReturnValue(chain);
    const { promise } = run();
    await promise;

    const projection = chain.select.mock.calls[0][0] as string;
    expect(projection).toContain('promptMeta.retrieval.attempted');
    expect(projection).toContain('promptMeta.retrieval.mode');
    expect(projection).toContain('promptMeta.retrieval.forcedSkipReason');
    expect(projection).not.toContain('dataLakeTags');
  });

  it('says so when the window exceeds the scan ceiling rather than reporting a silent prefix', async () => {
    // One row over the ceiling: the handler must drop the extra, report the truncation, and log
    // it. A rate quietly computed over a prefix of the window reads as if it covered all of it.
    mockFind.mockReturnValue(
      questChain(Array.from({ length: 50_001 }, () => row({ attempted: true, mode: 'optional' })))
    );
    const { res, promise } = run();
    await promise;

    expect(body(res).truncated).toBe(true);
    expect(body(res).turnsScanned).toBe(50_000);
    expect(body(res).summary.offeredTurns).toBe(50_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scan ceiling'), expect.any(Object));
  });

  it('counts a turn whose retrieval record predates the mode field as unclassified', async () => {
    mockFind.mockReturnValue(questChain([row({ attempted: true }), row(undefined)]));
    const { res, promise } = run();
    await promise;
    expect(body(res).summary).toMatchObject({ unclassifiedTurns: 1, offeredTurns: 0, rate: null });
  });
});

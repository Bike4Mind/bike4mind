import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `days` reaches the repository's `setDate(getDate() - days)`. A finite-but-huge value
 * overflows that into an Invalid Date, which casts against the Date-typed `createdAt` and,
 * now that errorHandler only maps a cast on `_id` to a 404, answers 500 with an
 * `error`-level log. This route is not admin-gated, so the bound has to hold here.
 */

const { mockFindByOwner } = vi.hoisted(() => ({ mockFindByOwner: vi.fn() }));

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

vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { findByOwnerWithFilters: (...a: unknown[]) => mockFindByOwner(...a) },
}));

import handler from '../transactions';

const run = (days?: string) => {
  const { req, res } = createMocks({
    method: 'GET',
    query: days === undefined ? {} : { days },
  });
  (req as Record<string, unknown>).user = { id: 'u1' };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockFindByOwner.mockReset().mockResolvedValue([]);
});

describe('GET /api/credits/transactions - days bound', () => {
  it.each([
    ['a value that overflows setDate into an Invalid Date', '99999999999999'],
    ['a window past the 365-day bound', '400'],
    ['zero', '0'],
    ['a negative window', '-30'],
    ['an unparseable window', 'abc'],
  ])('rejects %s with a 400 before any query runs', async (_label, days) => {
    const { res, promise } = run(days);
    await promise;

    expect(res._getStatusCode()).toBe(400);
    // Nothing reached the database, so no CastError could be thrown.
    expect(mockFindByOwner).not.toHaveBeenCalled();
    // Messages only. Serializing the ZodError itself puts zod's issue structure (`origin`,
    // `code`, `maximum`, the `path` array) on the wire as a pretty-printed blob.
    const body = res._getJSONData();
    expect(Array.isArray(body.details)).toBe(true);
    for (const d of body.details) expect(typeof d).toBe('string');
    expect(JSON.stringify(body)).not.toContain('ZodError');
    expect(JSON.stringify(body)).not.toContain('too_big');
  });

  it('passes a window inside the bound through to the repository', async () => {
    const { res, promise } = run('90');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindByOwner.mock.calls[0][2].days).toBe(90);
  });

  it('keeps the upper bound inclusive', async () => {
    const { promise } = run('365');
    await promise;
    expect(mockFindByOwner.mock.calls[0][2].days).toBe(365);
  });

  it('defaults the window to 30 days', async () => {
    const { promise } = run();
    await promise;
    expect(mockFindByOwner.mock.calls[0][2].days).toBe(30);
  });
});

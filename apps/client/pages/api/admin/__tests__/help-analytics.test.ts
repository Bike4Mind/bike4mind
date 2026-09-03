import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `dateFrom`/`dateTo` are validated by `parseDate`, but `tzOffset` is then applied to the
 * result with `setUTCMinutes`. A finite but absurd offset survives the `Number.isFinite`
 * check and overflows the already-valid Date into an Invalid Date, which casts against the
 * Date-typed `createdAt` on the seven schema-casting queries below - a 500 where the
 * blanket CastError mapping used to answer 404. The clamp is what keeps the shift in range.
 */

const mocks = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  countDocuments: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mocks.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

vi.mock('@bike4mind/database', () => ({
  HelpEventModel: {
    aggregate: () => Promise.resolve([]),
    countDocuments: (...a: unknown[]) => {
      mocks.countDocuments(...a);
      return Promise.resolve(0);
    },
    distinct: () => Promise.resolve([]),
    find: () => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }),
    }),
  },
}));

import '@pages/api/admin/help-analytics';

const run = (query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { isAdmin: true };
  return { res, promise: mocks.getHandler!(req, res) as Promise<unknown> };
};

// Every filter handed to a casting query shares one createdAt object; read it off the first.
const filterDates = (): Date[] => {
  const filter = mocks.countDocuments.mock.calls[0]?.[0] as { createdAt?: Record<string, Date> };
  return Object.values(filter?.createdAt ?? {});
};

beforeEach(() => {
  mocks.countDocuments.mockClear();
});

describe('GET /api/admin/help-analytics - tzOffset clamp', () => {
  it.each([
    ['a huge positive offset', '999999999999999999'],
    ['a huge negative offset', '-999999999999999999'],
  ])('clamps %s rather than shifting the date out of range', async (_label, tzOffset) => {
    const { promise } = run({ dateFrom: '2026-01-01', dateTo: '2026-02-01', tzOffset });
    await promise;

    const dates = filterDates();
    expect(dates).toHaveLength(2);
    for (const d of dates) {
      expect(Number.isNaN(d.getTime())).toBe(false);
    }
  });

  it('applies a real offset unchanged', async () => {
    // 480 = PST. Shifts UTC midnight to the caller's local midnight.
    const { promise } = run({ dateFrom: '2026-01-01', tzOffset: '480' });
    await promise;
    expect(filterDates()[0].toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  it('treats a non-numeric offset as no shift', async () => {
    const { promise } = run({ dateFrom: '2026-01-01', tzOffset: 'abc' });
    await promise;
    expect(filterDates()[0].toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('still rejects an unparseable date itself', async () => {
    const { promise } = run({ dateFrom: 'not-a-date' });
    await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });
});

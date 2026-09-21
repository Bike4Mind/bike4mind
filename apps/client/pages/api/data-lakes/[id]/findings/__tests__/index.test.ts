import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  listByLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => unknown) => unknown)[] = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        let index = 0;
        const next = async (): Promise<unknown> => {
          const middleware = middlewares[index++];
          if (middleware) return middleware(req, res, next);
          return routes[req.method ?? 'GET']?.(req, res);
        };
        return next();
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => unknown) => unknown) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeWriteAccess: h.assertLakeWriteAccess },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeFindingRepository: { listByLake: h.listByLake },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../index';

const lake = { id: 'lakeDoc1' };
const invoke = (query: Record<string, unknown> = {}) => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', query: { id: 'lake1', ...query }, user: { id: 'u1' } },
      res
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.listByLake.mockResolvedValue([]);
});

describe('GET /api/data-lakes/[id]/findings (#3039)', () => {
  it('gates on WRITE access, not read access - a finding carries document excerpts', async () => {
    // Same reason the sibling inconsistencies route is manage-gated: it is the PROSE that decides
    // the gate, not the mutation. A reader who can see a lake is not entitled to every member's
    // text. The read-gated view of this data stays the counts-only summary on GET /health.
    const { done } = invoke();
    await done;

    expect(h.assertLakeWriteAccess).toHaveBeenCalledTimes(1);
    expect(h.assertLakeWriteAccess.mock.calls[0][0]).toBe('lake1');
  });

  it('does not read findings when the gate refuses', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('denied'));

    await expect(invoke().done).rejects.toThrow('denied');
    expect(h.listByLake).not.toHaveBeenCalled();
  });

  it('lists against the RESOLVED lake id, not the route id, which can be a slug', async () => {
    const { done } = invoke();
    await done;

    expect(h.listByLake.mock.calls[0][0]).toBe('lakeDoc1');
  });

  it('passes each filter through independently', async () => {
    const { done } = invoke({ status: 'open', kind: 'expired-claim', detector: 'model', limit: '10' });
    await done;

    expect(h.listByLake.mock.calls[0][1]).toEqual({
      status: 'open',
      kind: 'expired-claim',
      detector: 'model',
      limit: 10,
    });
  });

  it('bounds an unfiltered read rather than returning the whole collection', async () => {
    const { done } = invoke();
    await done;

    expect(h.listByLake.mock.calls[0][1]).toEqual({
      status: undefined,
      kind: undefined,
      detector: undefined,
      limit: 50,
    });
  });

  it('rejects an unknown status, kind or detector instead of silently ignoring it', async () => {
    // A dropped filter would show a curator MORE findings than they asked for, which on a
    // manage-gated surface carrying excerpts is the wrong direction to fail in.
    await expect(invoke({ status: 'archived' }).done).rejects.toThrow();
    await expect(invoke({ kind: 'not-a-kind' }).done).rejects.toThrow();
    await expect(invoke({ detector: 'psychic' }).done).rejects.toThrow();
  });

  it('refuses a repeated limit rather than coercing the array to a number', async () => {
    // `?limit=10&limit=20` arrives as a string[], and `z.coerce.number()` on an array does NOT
    // throw on its own - Number(['10']) is 10, so a single-element array would coerce silently and
    // a two-element one lands as NaN. Pinned so the page bound stays a thing the schema decides.
    await expect(invoke({ limit: ['10', '20'] as unknown as string }).done).rejects.toThrow();
    expect(h.listByLake).not.toHaveBeenCalled();
  });

  it('refuses a SINGLE-element limit array, which coerces silently rather than landing NaN', async () => {
    // The one the multi-element case above cannot catch, and the reason the schema pins its input
    // to a scalar before coercing: Number(['10']) is 10, so a bare z.coerce.number() would accept
    // this shape and no assertion anywhere would notice the array had been swallowed.
    await expect(invoke({ limit: ['10'] as unknown as string }).done).rejects.toThrow();
    expect(h.listByLake).not.toHaveBeenCalled();
  });

  it('refuses a limit above the page cap', async () => {
    await expect(invoke({ limit: '500' }).done).rejects.toThrow();
  });

  it('returns the rows under data', async () => {
    const rows = [{ id: 'f1', kind: 'expired-claim' }];
    h.listByLake.mockResolvedValue(rows);

    const { json, done } = invoke();
    await done;

    expect(json).toHaveBeenCalledWith({ data: rows });
  });
});

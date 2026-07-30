// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Query-validation bounds for GET /api/data-lakes/public. The route parses with
 * BrowseQuery.parse, so a bad query REJECTS the handler promise; turning that into a 422 is
 * errorHandler's job (server/middlewares/errorHandler.ts), and the baseApi mock below replaces
 * the chain that wires it, so no status is observable here. What this pins at this seam: a
 * rejected query never reaches the service, and an accepted one arrives coerced.
 */

const { mockBrowse, LAKES_REPO, USERS_REPO } = vi.hoisted(() => ({
  mockBrowse: vi.fn(),
  // Distinguishable sentinels so the adapter case can assert identity pass-through.
  LAKES_REPO: { __tag: 'dataLakeRepository' },
  USERS_REPO: { __tag: 'userRepository' },
}));

// The route is baseApi().use(...).get(fn), so `use` must return the chain and `get` returns the
// raw handler - which makes the module's default export the handler itself.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { browsePublicDataLakes: mockBrowse } }));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: LAKES_REPO, userRepository: USERS_REPO }));

import handler from '@pages/api/data-lakes/public';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const EMPTY_RESULT = { data: [], total: 0 };

// `query` is always passed, even when empty: BrowseQuery.parse(undefined) throws its own
// invalid_type error, which would satisfy a rejection assertion for the wrong reason.
const makeReq = (query: Record<string, string | string[]>, user: Record<string, unknown> = { id: 'u1' }) => ({
  query,
  user,
});

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.json = vi.fn(() => res);
  return res as { json: ReturnType<typeof vi.fn> };
};

/** The three positional args the route passes to browsePublicDataLakes: (actor, opts, adapters). */
const browseArgs = () => mockBrowse.mock.calls[0];
const browseOpts = () => browseArgs()[1] as { search?: unknown; limit?: unknown; offset?: unknown };

const expectRejected = async (query: Record<string, string | string[]>, field: string) => {
  await expect(route(makeReq(query), makeRes())).rejects.toMatchObject({
    name: 'ZodError',
    issues: expect.arrayContaining([expect.objectContaining({ path: [field] })]),
  });
  expect(mockBrowse).not.toHaveBeenCalled();
};

describe('GET /api/data-lakes/public - query bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue(EMPTY_RESULT);
  });

  it('rejects a limit above the cap', () => expectRejected({ limit: '61' }, 'limit'));

  // Number('abc') is NaN, so zod's base number gate rejects it before .int()/.min()/.max() run.
  it('rejects a non-numeric limit', () => expectRejected({ limit: 'abc' }, 'limit'));

  it('rejects a limit below the minimum', () => expectRejected({ limit: '0' }, 'limit'));

  it('rejects a fractional limit', () => expectRejected({ limit: '10.5' }, 'limit'));

  it('rejects a negative offset', () => expectRejected({ offset: '-1' }, 'offset'));

  it('rejects a search term over the length cap', () => expectRejected({ q: 'x'.repeat(201) }, 'q'));

  it('accepts the cap itself - the bound is inclusive', async () => {
    await route(makeReq({ limit: '60', offset: '0' }), makeRes());
    expect(browseOpts()).toEqual({ search: undefined, limit: 60, offset: 0 });
  });

  // .optional() short-circuits on undefined before coercion runs, so an absent limit stays
  // undefined rather than becoming Number(undefined) === NaN.
  it('leaves absent paging params undefined rather than coercing them', async () => {
    await route(makeReq({}), makeRes());
    expect(browseOpts().limit).toBeUndefined();
    expect(browseOpts().offset).toBeUndefined();
  });

  it('coerces query strings to numbers', async () => {
    await route(makeReq({ limit: '24', offset: '24' }), makeRes());
    expect(browseOpts()).toEqual({ search: undefined, limit: 24, offset: 24 });
    expect(typeof browseOpts().limit).toBe('number');
    expect(typeof browseOpts().offset).toBe('number');
  });

  // Number('') is 0, which clears .min(0) - asymmetric with an empty limit, which fails .min(1).
  it('accepts an empty offset as 0', async () => {
    await route(makeReq({ offset: '' }), makeRes());
    expect(browseOpts().offset).toBe(0);
  });
});

describe('GET /api/data-lakes/public - search and pass-through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue(EMPTY_RESULT);
  });

  it('trims the search term', async () => {
    await route(makeReq({ q: '  sales  ' }), makeRes());
    expect(browseOpts().search).toBe('sales');
  });

  it('forwards an absent q as undefined', async () => {
    await route(makeReq({}), makeRes());
    expect(browseOpts().search).toBeUndefined();
  });

  // An empty q is a valid string here, so the route forwards ''. The empty search is dropped
  // downstream at the repository (packages/database/src/models/ai/DataLakeModel.ts, where a
  // falsy trimmed search adds no regex clause), not in this file.
  it('forwards an empty q as an empty string', async () => {
    await route(makeReq({ q: '' }), makeRes());
    expect(browseOpts().search).toBe('');
  });

  it('passes a non-admin caller through as isAdmin false, not undefined', async () => {
    await route(makeReq({}, { id: 'u1' }), makeRes());
    expect(browseArgs()[0]).toEqual({ userId: 'u1', isAdmin: false });
  });

  it('passes the repositories through by identity', async () => {
    await route(makeReq({}), makeRes());
    expect(browseArgs()[2].db.dataLakes).toBe(LAKES_REPO);
    expect(browseArgs()[2].db.users).toBe(USERS_REPO);
  });

  it('returns the service result as JSON', async () => {
    const result = { data: [], total: 7 };
    mockBrowse.mockResolvedValue(result);
    const res = makeRes();
    await route(makeReq({}), res);
    expect(res.json).toHaveBeenCalledWith(result);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { Types } from 'mongoose';

/**
 * Handler-layer regression coverage for the regex-injection / ReDoS hardening.
 * The model/unit suites prove `escapeRegex` works; this proves the fix holds at
 * the HTTP boundary where user input actually enters - the `searchTerm` query
 * param must reach `$regex` escaped, never raw.
 */

// Collapse the baseApi().get().post() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  findQuery: undefined as unknown,
  countQuery: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/content', () => ({
  ResearchLink: {
    countDocuments: (q: unknown) => {
      mockRefs.countQuery = q;
      return Promise.resolve(0);
    },
    find: (q: unknown) => {
      mockRefs.findQuery = q;
      return {
        sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
      };
    },
  },
  ResearchLinkCategory: {
    findById: () => ({ lean: () => Promise.resolve(null) }),
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/business-links';

const REDOS_PAYLOAD = '(a+)+$';

function invokeGet(query: Record<string, string>) {
  const { req, res } = createMocks({
    method: 'GET',
    query,
    url: '/api/business-links',
  });
  return { req, res };
}

describe('GET /api/business-links — regex-injection hardening', () => {
  beforeEach(() => {
    mockRefs.findQuery = undefined;
    mockRefs.countQuery = undefined;
  });

  it('escapes the searchTerm before it reaches $regex', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');

    const { req, res } = invokeGet({ searchTerm: REDOS_PAYLOAD });
    await mockRefs.getHandler!(req, res);

    const orConditions = (mockRefs.findQuery as { $or?: Array<Record<string, { $regex: string }>> })?.$or;
    expect(orConditions, 'search should build a $or query').toBeInstanceOf(Array);

    const escaped = escapeRegex(REDOS_PAYLOAD);
    for (const condition of orConditions!) {
      const [{ $regex }] = Object.values(condition);
      // The escaped, backtracking-safe literal, never the raw payload.
      expect($regex).toBe(escaped);
      expect($regex).not.toBe(REDOS_PAYLOAD);
    }

    // Sanity: escaping neutralizes the catastrophic-backtracking pattern.
    expect(new RegExp(escaped).test('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('builds an empty query (no $regex) when no searchTerm is provided', async () => {
    const { req, res } = invokeGet({ searchTerm: '' });
    await mockRefs.getHandler!(req, res);

    expect((mockRefs.findQuery as { $or?: unknown })?.$or).toBeUndefined();
  });
});

describe('GET /api/business-links - categoryId validation', () => {
  beforeEach(() => {
    mockRefs.findQuery = undefined;
    mockRefs.countQuery = undefined;
  });

  it('rejects a malformed categoryId with 400 instead of letting it cast', async () => {
    const { req, res } = invokeGet({ categoryId: 'not-an-object-id' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid category ID format' });
    // Nothing reached the database, so no CastError could be thrown.
    expect(mockRefs.findQuery).toBeUndefined();
    expect(mockRefs.countQuery).toBeUndefined();
  });

  it('passes a well-formed categoryId through to the query', async () => {
    const categoryId = new Types.ObjectId().toString();
    const { req, res } = invokeGet({ categoryId });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.findQuery).toMatchObject({ categoryId });
  });
});

/**
 * The shape the app actually sends. `apiClient` serializes the hook's nested
 * `filters` through `qs` into bracket keys, and Next.js hands those to `req.query`
 * unexpanded - so a route reading `req.query.categoryId` sees nothing and returns
 * every link, unfiltered. These drive the handler with those literal bracket keys.
 */
describe('GET /api/business-links - nested filters from the client', () => {
  beforeEach(() => {
    mockRefs.findQuery = undefined;
    mockRefs.countQuery = undefined;
  });

  it('applies filters[categoryId] to the query', async () => {
    const categoryId = new Types.ObjectId().toString();
    const { req, res } = invokeGet({ 'filters[categoryId]': categoryId });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.findQuery).toMatchObject({ categoryId });
    expect(mockRefs.countQuery).toMatchObject({ categoryId });
  });

  it('escapes filters[search] before it reaches $regex', async () => {
    const { req, res } = invokeGet({ 'filters[search]': REDOS_PAYLOAD });
    await mockRefs.getHandler!(req, res);

    const orConditions = (mockRefs.findQuery as { $or?: Array<Record<string, { $regex: string }>> })?.$or;
    expect(orConditions, 'nested search should build a $or query').toBeInstanceOf(Array);

    const escaped = escapeRegex(REDOS_PAYLOAD);
    for (const condition of orConditions!) {
      const [{ $regex }] = Object.values(condition);
      expect($regex).toBe(escaped);
      expect($regex).not.toBe(REDOS_PAYLOAD);
    }
  });

  it('applies filters[categoryId] and filters[search] together', async () => {
    const categoryId = new Types.ObjectId().toString();
    const { req, res } = invokeGet({ 'filters[categoryId]': categoryId, 'filters[search]': 'acme' });
    await mockRefs.getHandler!(req, res);

    expect(mockRefs.findQuery).toMatchObject({ categoryId });
    expect((mockRefs.findQuery as { $or?: unknown[] })?.$or).toBeInstanceOf(Array);
  });

  it('rejects a malformed filters[categoryId] with 400', async () => {
    const { req, res } = invokeGet({ 'filters[categoryId]': 'not-an-object-id' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid category ID format' });
    expect(mockRefs.findQuery).toBeUndefined();
  });

  it('ignores a filter value that bracket-nests into a non-string', async () => {
    // `filters[search][x]=1` parses to an object; it must be treated as absent
    // rather than reaching escapeRegex, which would throw on a non-string.
    const { req, res } = invokeGet({ 'filters[search][x]': '1', 'filters[categoryId][y]': '2' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((mockRefs.findQuery as { $or?: unknown })?.$or).toBeUndefined();
    expect((mockRefs.findQuery as { categoryId?: unknown })?.categoryId).toBeUndefined();
  });
});

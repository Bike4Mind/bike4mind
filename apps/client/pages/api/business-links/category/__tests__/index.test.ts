import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

/**
 * Handler-layer coverage for the category list's search filter. The client sends
 * the filter nested (`filters[search]=...`), Next.js leaves the bracket key
 * unexpanded, so a route reading `req.query.searchTerm` sees nothing and returns
 * every category. These drive the handler with the literal bracket keys it
 * actually receives, and pin the escaping now that user input reaches `$regex`
 * on a path a browser request can take.
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
  ResearchLinkCategory: {
    countDocuments: (q: unknown) => {
      mockRefs.countQuery = q;
      return Promise.resolve(0);
    },
    find: (q: unknown) => {
      mockRefs.findQuery = q;
      return {
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
      };
    },
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/business-links/category';

const REDOS_PAYLOAD = '(a+)+$';

function invokeGet(query: Record<string, string | string[]>) {
  const { req, res } = createMocks({
    method: 'GET',
    query,
    url: '/api/business-links/category',
  });
  return { req, res };
}

function regexOperands(query: unknown) {
  const orConditions = (query as { $or?: Array<Record<string, { $regex: string }>> })?.$or;
  expect(orConditions, 'search should build a $or query').toBeInstanceOf(Array);
  return orConditions!.map(condition => Object.values(condition)[0].$regex);
}

describe('GET /api/business-links/category - nested filters from the client', () => {
  beforeEach(() => {
    mockRefs.findQuery = undefined;
    mockRefs.countQuery = undefined;
  });

  it('applies filters[search] to the query', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');

    const { req, res } = invokeGet({ 'filters[search]': 'acme' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(regexOperands(mockRefs.findQuery)).toEqual(['acme', 'acme']);
    // The count must be filtered too, or the pagination total disagrees with the rows.
    expect(regexOperands(mockRefs.countQuery)).toEqual(['acme', 'acme']);
  });

  it('still applies the legacy flat searchTerm', async () => {
    const { req, res } = invokeGet({ searchTerm: 'acme' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(regexOperands(mockRefs.findQuery)).toEqual(['acme', 'acme']);
  });

  it('escapes filters[search] before it reaches $regex', async () => {
    const { req, res } = invokeGet({ 'filters[search]': REDOS_PAYLOAD });
    await mockRefs.getHandler!(req, res);

    const escaped = escapeRegex(REDOS_PAYLOAD);
    for (const operand of regexOperands(mockRefs.findQuery)) {
      // The escaped, backtracking-safe literal, never the raw payload.
      expect(operand).toBe(escaped);
      expect(operand).not.toBe(REDOS_PAYLOAD);
    }

    // Sanity: escaping neutralizes the catastrophic-backtracking pattern.
    expect(new RegExp(escaped).test('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('builds an empty query when no search filter is provided', async () => {
    const { req, res } = invokeGet({ pageSize: '10', pageNumber: '1' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.findQuery).toEqual({});
  });

  it('ignores a filter value that bracket-nests into a non-string', async () => {
    // `filters[search][x]=1` parses to an object; it must be treated as absent
    // rather than reaching escapeRegex, which would throw on a non-string.
    const { req, res } = invokeGet({ 'filters[search][x]': '1' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((mockRefs.findQuery as { $or?: unknown })?.$or).toBeUndefined();
  });

  it('ignores a repeated filters[search] that parses to an array', async () => {
    const { req, res } = invokeGet({ 'filters[search]': ['acme', 'other'] });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((mockRefs.findQuery as { $or?: unknown })?.$or).toBeUndefined();
  });
});

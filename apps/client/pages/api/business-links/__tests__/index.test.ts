import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

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

function invokeGet(searchTerm: string) {
  const { req, res } = createMocks({
    method: 'GET',
    query: { searchTerm },
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

    const { req, res } = invokeGet(REDOS_PAYLOAD);
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
    const { req, res } = invokeGet('');
    await mockRefs.getHandler!(req, res);

    expect((mockRefs.findQuery as { $or?: unknown })?.$or).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import '../by-identifier';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: NextApiRequest, res: NextApiResponse) => unknown),
  baseApiOptions: undefined as unknown,
  findArgs: undefined as unknown[] | undefined,
  match: null as null | { id: string },
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: NonNullable<typeof mockRefs.getHandler>) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { __repo: 'artifacts' },
}));

vi.mock('@bike4mind/services', () => ({
  artifactService: {
    findByIdentifier: (...args: unknown[]) => {
      mockRefs.findArgs = args;
      return Promise.resolve(mockRefs.match);
    },
  },
}));

function invoke(query: Record<string, unknown>, user: { id: string } | null = { id: 'user-1' }) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'GET',
    url: '/api/artifacts/by-identifier',
    query: query as NextApiRequest['query'],
  });
  Object.assign(req, { user });
  return { req, res };
}

describe('GET /api/artifacts/by-identifier', () => {
  beforeEach(() => {
    mockRefs.findArgs = undefined;
    mockRefs.match = null;
  });

  it('hands the caller and the lookup keys to the service', async () => {
    mockRefs.match = { id: 'artifact_react_app_1_0' };
    const { req, res } = invoke({ sessionId: 's1', type: 'react', identifier: 'app' });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.findArgs?.[0]).toBe('user-1');
    expect(mockRefs.findArgs?.[1]).toEqual({ sessionId: 's1', type: 'react', identifier: 'app' });
    expect(res._getJSONData()).toEqual({ artifact: { id: 'artifact_react_app_1_0' } });
  });

  it('accepts a signed-in session only, never an API key', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('answers with a null artifact when nothing readable matches', async () => {
    const { req, res } = invoke({ sessionId: 's1', type: 'react', identifier: 'app' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual({ artifact: null });
  });

  it('is never cached', async () => {
    const { req, res } = invoke({ sessionId: 's1', type: 'react', identifier: 'app' });

    await mockRefs.getHandler!(req, res);

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('rejects an unauthenticated caller without touching the service', async () => {
    const { req, res } = invoke({ sessionId: 's1', type: 'react', identifier: 'app' }, null);

    await mockRefs.getHandler!(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockRefs.findArgs).toBeUndefined();
  });

  it.each([
    ['a bracketed operator', { sessionId: 's1', type: 'react', 'identifier[$ne]': 'x' }],
    ['a repeated param', { sessionId: 's1', type: 'react', identifier: ['a', 'b'] }],
    ['a missing session', { type: 'react', identifier: 'app' }],
    ['an empty identifier', { sessionId: 's1', type: 'react', identifier: '' }],
  ])('rejects %s before it reaches the query', async (_label, query) => {
    const { req, res } = invoke(query);

    await expect(Promise.resolve(mockRefs.getHandler!(req, res))).rejects.toThrow();
    expect(mockRefs.findArgs).toBeUndefined();
  });
});

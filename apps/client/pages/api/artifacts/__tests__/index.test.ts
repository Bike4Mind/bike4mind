import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import '../index';

/**
 * The parser itself is pinned where `queryBool` is defined. These pin the plumbing: the bug
 * travelled qs.parse -> schema -> service, and only the last hop decides whether soft-deleted rows
 * are filtered, so a route that parsed correctly and then forwarded the raw query would still ship
 * it.
 */

// Collapse the baseApi().get().post() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  listArgs: undefined as unknown[] | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { __repo: 'artifacts' },
  artifactContentRepository: { __repo: 'artifactContents' },
  artifactVersionRepository: { __repo: 'artifactVersions' },
}));

vi.mock('@bike4mind/services', () => ({
  artifactService: {
    list: (...args: unknown[]) => {
      mockRefs.listArgs = args;
      return Promise.resolve({ artifacts: [], pagination: { total: 0 } });
    },
  },
}));

function invokeGet(query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/artifacts', query: query as any });
  (req as any).user = { id: 'user-1' };
  return { req, res };
}

const includeDeletedArg = () => (mockRefs.listArgs?.[1] as { includeDeleted?: unknown } | undefined)?.includeDeleted;

describe('GET /api/artifacts', () => {
  it('hands the service a real boolean false for ?includeDeleted=false', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ includeDeleted: 'false' });

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(false);
  });

  it('hands the service true for ?includeDeleted=true', async () => {
    const { req, res } = invokeGet({ includeDeleted: 'true' });

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(true);
  });

  it('defaults to false when the caller omits the param', async () => {
    const { req, res } = invokeGet({});

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(false);
  });
});

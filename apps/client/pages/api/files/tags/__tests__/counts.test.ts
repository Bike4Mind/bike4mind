import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getDataLakeTags } from '@bike4mind/common';

/**
 * Route-layer coverage for GET /api/files/tags/counts. Both halves of this response feed one
 * screen - the client keys its workspace rows off the tag counts and sizes them from the namespace
 * counts - so handing the two aggregates different scopes renders a shared or data-lake workspace
 * as empty. Only a route-level test can catch that; the aggregates themselves are fine in isolation.
 */

// Collapse the baseApi().get() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  tagArgs: undefined as unknown[] | undefined,
  namespaceArgs: undefined as unknown[] | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {
    countFilesByTagForUser: (...args: unknown[]) => {
      mockRefs.tagArgs = args;
      return Promise.resolve([]);
    },
    countUniqueFilesByNamespaceForUser: (...args: unknown[]) => {
      mockRefs.namespaceArgs = args;
      return Promise.resolve([]);
    },
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files/tags/counts';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry, so getDataLakeTags
// resolves to a non-empty set here. Without it every assertion below passes vacuously on [].
const USER_TAGS = ['Opti', 'some-arbitrary-tag'];

function invokeGet(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files/tags/counts' });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/files/tags/counts', () => {
  beforeEach(() => {
    mockRefs.tagArgs = undefined;
    mockRefs.namespaceArgs = undefined;
  });

  it('counts tags and namespaces over the same scope', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    const expectedScope = { userGroups: ['group-a'], dataLakeTags: getDataLakeTags(USER_TAGS) };
    expect(mockRefs.tagArgs).toEqual(['user-1', expectedScope]);
    expect(mockRefs.namespaceArgs).toEqual(['user-1', expectedScope]);
  });

  // The namespace aggregate falls back to owner-only when called with no scope, so forgetting the
  // second argument is a silent narrowing rather than an error.
  it('does not leave the namespace count unscoped', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.namespaceArgs?.[1]).toBeDefined();
    expect((mockRefs.namespaceArgs?.[1] as { dataLakeTags: string[] }).dataLakeTags).toContain(
      'datalake:opti-knowledge'
    );
  });

  it('derives data-lake tags rather than forwarding the raw user tags', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    for (const args of [mockRefs.tagArgs, mockRefs.namespaceArgs]) {
      const { dataLakeTags } = args?.[1] as { dataLakeTags: string[] };
      expect(dataLakeTags).not.toContain('some-arbitrary-tag');
      expect(dataLakeTags).not.toContain('Opti');
    }
  });

  it('defaults missing groups and tags to empty rather than passing undefined', async () => {
    const { req, res } = invokeGet({ id: 'user-1' });

    await mockRefs.getHandler!(req, res);

    const expectedScope = { userGroups: [], dataLakeTags: getDataLakeTags([]) };
    expect(mockRefs.tagArgs?.[1]).toEqual(expectedScope);
    expect(mockRefs.namespaceArgs?.[1]).toEqual(expectedScope);
  });

  it('rejects an unauthenticated caller before touching the repository', async () => {
    const { req, res } = invokeGet({});

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.tagArgs).toBeUndefined();
    expect(mockRefs.namespaceArgs).toBeUndefined();
  });
});

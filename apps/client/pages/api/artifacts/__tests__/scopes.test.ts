// @vitest-environment node
/**
 * The internal /api/artifacts routes that the public v1 routes mirror declare an API-key scope
 * posture: reads take notebooks:read or notebooks:write, and POST /api/artifacts/[id]/versions
 * additionally needs notebooks:write at the verb, since the route-level list admits read keys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { baseApiOptions, handlers, mockGet, mockUpdate } = vi.hoisted(() => ({
  baseApiOptions: [] as { requiredScopes?: string[] }[],
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: { requiredScopes?: string[] }) => {
    baseApiOptions.push(options);
    const chain: Record<string, unknown> = {};
    for (const verb of ['get', 'post']) {
      chain[verb] = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        handlers[`${baseApiOptions.length}:${verb}`] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/services', () => ({ artifactService: { get: mockGet, update: mockUpdate, list: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  artifactRepository: {},
  artifactContentRepository: {},
  artifactVersionRepository: { findByArtifactId: vi.fn().mockResolvedValue([]) },
}));

await import('../types');
await import('../search');
await import('../[id]/versions');

const BODY = { content: 'graph TD; A-->B' };
const READ_OR_WRITE = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS];

function post(scopes: string[] | null) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'a1' }, body: BODY });
  Object.assign(req, { user: { id: 'u1' }, ...(scopes && { apiKeyInfo: { scopes } }) });
  // The versions route is the third baseApi() in import order.
  return { run: () => handlers['3:post'](req, res), res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ artifact: { version: 1 } });
  mockUpdate.mockResolvedValue({ id: 'a1' });
});

describe('internal artifact routes declare notebooks scopes', () => {
  it('types, search and versions accept a notebooks read or write key', () => {
    expect(baseApiOptions.map(o => o.requiredScopes)).toEqual([READ_OR_WRITE, READ_OR_WRITE, READ_OR_WRITE]);
  });

  it('POST versions refuses a read-only key and writes nothing', async () => {
    await expect(post([ApiKeyScope.READ_NOTEBOOKS]).run()).rejects.toMatchObject({ statusCode: 403 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('POST versions accepts a write key and a JWT caller', async () => {
    await post([ApiKeyScope.WRITE_NOTEBOOKS]).run();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await post(null).run();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('internal artifact responses are not cacheable', () => {
  const run = async (key: string, query: Record<string, string>, method: 'GET' | 'POST' = 'GET') => {
    const { req, res } = createMocks({ method, query, body: BODY });
    Object.assign(req, { user: { id: 'u1' } });
    await handlers[key](req, res);
    return res;
  };

  it.each([
    ['types', '1:get', {}],
    ['search', '2:get', { q: 'x' }],
    ['versions list', '3:get', { id: 'a1' }],
  ])('%s sends no-store', async (_name, key, query) => {
    expect((await run(key, query)).getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('version-create sends no-store', async () => {
    expect((await run('3:post', { id: 'a1' }, 'POST')).getHeader('Cache-Control')).toBe('private, no-store');
  });
});

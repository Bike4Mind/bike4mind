// @vitest-environment node
/**
 * /api/artifacts/[id] and /api/artifacts/[id]/versions/[version] take a notebooks read or write key at
 * the door; PUT and DELETE on the artifact also need notebooks:write at the verb.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { baseApiOptions, handlers, mockUpdate, mockDelete } = vi.hoisted(() => ({
  baseApiOptions: [] as { requiredScopes?: string[] }[],
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: { requiredScopes?: string[] }) => {
    baseApiOptions.push(options);
    const route = baseApiOptions.length;
    const chain: Record<string, unknown> = {};
    for (const verb of ['get', 'put', 'delete']) {
      chain[verb] = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        handlers[`${route}:${verb}`] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/services', () => ({
  artifactService: { get: vi.fn(), update: mockUpdate, delete: mockDelete },
}));
vi.mock('@bike4mind/database', () => ({
  artifactRepository: {},
  artifactContentRepository: {},
  artifactVersionRepository: {},
}));

await import('../[id]/index');
await import('../[id]/versions/[version]');

const READ_OR_WRITE = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS];

function call(verb: 'put' | 'delete', scopes: string[] | null) {
  const { req, res } = createMocks({ method: verb.toUpperCase() as 'PUT' | 'DELETE', query: { id: 'a1' }, body: {} });
  Object.assign(req, { user: { id: 'u1' }, ...(scopes && { apiKeyInfo: { scopes } }) });
  return handlers[`1:${verb}`](req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ id: 'a1' });
  mockDelete.mockResolvedValue({ id: 'a1' });
});

describe('artifact by-id routes declare notebooks scopes', () => {
  it('both routes accept a notebooks read or write key at the door', () => {
    expect(baseApiOptions.map(o => o.requiredScopes)).toEqual([READ_OR_WRITE, READ_OR_WRITE]);
  });

  it.each(['put', 'delete'] as const)('%s refuses a read-only key and changes nothing', async verb => {
    await expect(call(verb, [ApiKeyScope.READ_NOTEBOOKS])).rejects.toMatchObject({ statusCode: 403 });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('put and delete accept a write key and a session caller', async () => {
    await call('put', [ApiKeyScope.WRITE_NOTEBOOKS]);
    await call('put', null);
    await call('delete', [ApiKeyScope.WRITE_NOTEBOOKS]);
    await call('delete', null);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });
});

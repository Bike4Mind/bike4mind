import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-level tests for /api/work-items. The repository is mocked - its own
 * behaviour (cycle detection, readiness, graph building) is covered against a
 * real Mongo in packages/database/src/models/ai/WorkItemModel.test.ts.
 */

type Handler = (req: any, res: any) => Promise<unknown>;

const handlers = vi.hoisted(
  () => ({}) as Record<string, Partial<Record<'get' | 'post' | 'patch' | 'delete', Handler>>>
);

// Each route module gets its own handler slot, keyed by the module registering
// first; vi.mock is shared, so the key is assigned at import time below.
const currentModule = vi.hoisted(() => ({ name: '' }));

vi.mock('@server/middlewares/baseApi', () => {
  const makeChain = () => {
    const slot = (handlers[currentModule.name] ??= {});
    const chain: any = {
      use: () => chain,
      get: (fn: Handler) => ((slot.get = fn), chain),
      post: (fn: Handler) => ((slot.post = fn), chain),
      patch: (fn: Handler) => ((slot.patch = fn), chain),
      delete: (fn: Handler) => ((slot.delete = fn), chain),
    };
    return chain;
  };
  return { baseApi: () => makeChain() };
});

const repo = vi.hoisted(() => ({
  listForUser: vi.fn(),
  findByIdForUser: vi.fn(),
  findManyByIdsForUser: vi.fn(),
  listReadyForUser: vi.fn(),
  buildGraphForUser: vi.fn(),
  updateForUser: vi.fn(),
  softDeleteForUser: vi.fn(),
  detectDependencyCycle: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ workItemRepository: repo }));

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));

currentModule.name = 'collection';
await import('@pages/api/work-items/index');
currentModule.name = 'item';
await import('@pages/api/work-items/[id]/index');
currentModule.name = 'ready';
await import('@pages/api/work-items/ready');
currentModule.name = 'graph';
await import('@pages/api/work-items/graph');

const OID_A = '507f1f77bcf86cd799439011';
const OID_B = '507f1f77bcf86cd799439012';

const call = (module: string, method: 'get' | 'post' | 'patch' | 'delete', options: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: method.toUpperCase(), ...options } as any);
  (req as any).user = { id: 'u1', isAdmin: false };
  return { res, result: handlers[module][method]!(req, res) };
};

const item = (overrides: Record<string, unknown> = {}) => ({
  id: OID_A,
  userId: 'u1',
  title: 'Ship it',
  status: 'open',
  dependencies: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrgAccess.mockResolvedValue(undefined);
});

describe('GET /api/work-items', () => {
  beforeEach(() => repo.listForUser.mockResolvedValue({ data: [], hasMore: false, total: 0 }));

  it('scopes the query to the caller and applies defaults', async () => {
    const { res, result } = call('collection', 'get', { query: {} });
    await result;

    expect(repo.listForUser).toHaveBeenCalledWith(
      'u1',
      {},
      { page: 1, limit: 50 },
      { by: 'updatedAt', direction: 'desc' }
    );
    expect(res._getJSONData()).toEqual({ data: [], hasMore: false, total: 0 });
  });

  it('parses a comma-separated status filter and a search query', async () => {
    await call('collection', 'get', { query: { status: 'open,blocked', query: 'deploy' } }).result;

    expect(repo.listForUser).toHaveBeenCalledWith(
      'u1',
      { status: ['open', 'blocked'], search: 'deploy' },
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects an unknown status value', async () => {
    await expect(call('collection', 'get', { query: { status: 'nope' } }).result).rejects.toThrow(/status must be/);
  });

  it('caps limit and floors page so a client cannot pull the whole backlog', async () => {
    await call('collection', 'get', { query: { limit: '5000', page: '-3' } }).result;

    expect(repo.listForUser).toHaveBeenCalledWith('u1', {}, { page: 1, limit: 200 }, expect.anything());
  });

  it('falls back to a safe sort when given an unknown orderBy', async () => {
    await call('collection', 'get', { query: { orderBy: 'userId; drop', orderDirection: 'sideways' } }).result;

    expect(repo.listForUser).toHaveBeenCalledWith('u1', {}, expect.anything(), {
      by: 'updatedAt',
      direction: 'desc',
    });
  });

  it('checks org membership before filtering by organization', async () => {
    await call('collection', 'get', { query: { organizationId: 'org1' } }).result;

    expect(verifyOrgAccess).toHaveBeenCalledWith({ id: 'u1', isAdmin: false }, 'org1');
  });

  it('does not query when the org check fails', async () => {
    verifyOrgAccess.mockRejectedValue(new Error('forbidden'));

    await expect(call('collection', 'get', { query: { organizationId: 'org1' } }).result).rejects.toThrow('forbidden');
    expect(repo.listForUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/work-items', () => {
  beforeEach(() => {
    repo.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: OID_A, ...doc }));
    repo.findManyByIdsForUser.mockResolvedValue([]);
    repo.detectDependencyCycle.mockResolvedValue(false);
  });

  it('creates an open item owned by the caller and responds 201', async () => {
    const { res, result } = call('collection', 'post', { body: { title: '  Ship it  ' } });
    await result;

    expect(repo.create).toHaveBeenCalledWith({
      userId: 'u1',
      title: 'Ship it',
      status: 'open',
      dependencies: [],
    });
    expect(res._getStatusCode()).toBe(201);
  });

  it('requires a title', async () => {
    await expect(call('collection', 'post', { body: {} }).result).rejects.toThrow(/title is required/);
  });

  it('rejects an over-long title', async () => {
    await expect(call('collection', 'post', { body: { title: 'x'.repeat(301) } }).result).rejects.toThrow(
      /300 characters or fewer/
    );
  });

  it('stamps closedAt when created already closed', async () => {
    await call('collection', 'post', { body: { title: 'Ship it', status: 'closed' } }).result;

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'closed', closedAt: expect.any(Date) }));
  });

  it('rejects a dependency id that is not an object id', async () => {
    await expect(
      call('collection', 'post', { body: { title: 'Ship it', dependencies: ['not-an-id'] } }).result
    ).rejects.toThrow(/invalid work item id/);
  });

  it('rejects dependencies the caller does not own', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([]);

    await expect(
      call('collection', 'post', { body: { title: 'Ship it', dependencies: [OID_B] } }).result
    ).rejects.toThrow(/Unknown work item dependencies/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects dependencies that would form a cycle', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([item({ id: OID_B })]);
    repo.detectDependencyCycle.mockResolvedValue(true);

    await expect(
      call('collection', 'post', { body: { title: 'Ship it', dependencies: [OID_B] } }).result
    ).rejects.toThrow(/cycle/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('deduplicates a repeated dependency id', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([item({ id: OID_B })]);

    await call('collection', 'post', { body: { title: 'Ship it', dependencies: [OID_B, OID_B] } }).result;

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ dependencies: [OID_B] }));
  });
});

describe('GET /api/work-items/:id', () => {
  it('returns the item', async () => {
    repo.findByIdForUser.mockResolvedValue(item());

    const { res, result } = call('item', 'get', { query: { id: OID_A } });
    await result;

    expect(repo.findByIdForUser).toHaveBeenCalledWith(OID_A, 'u1');
    expect(res._getJSONData()).toMatchObject({ id: OID_A });
  });

  it("404s rather than leaking another user's item", async () => {
    repo.findByIdForUser.mockResolvedValue(null);

    await expect(call('item', 'get', { query: { id: OID_A } }).result).rejects.toThrow(/not found/i);
  });
});

describe('PATCH /api/work-items/:id', () => {
  beforeEach(() => {
    repo.findByIdForUser.mockResolvedValue(item());
    repo.updateForUser.mockImplementation(async (_id: string, _u: string, patch: Record<string, unknown>) => ({
      ...item(),
      ...patch,
    }));
    repo.findManyByIdsForUser.mockResolvedValue([]);
    repo.detectDependencyCycle.mockResolvedValue(false);
  });

  it('patches only the fields supplied', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { title: 'Renamed' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { title: 'Renamed' });
  });

  it('stamps closedAt when the item is closed', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { status: 'closed' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', {
      status: 'closed',
      closedAt: expect.any(Date),
    });
  });

  it('clears closedAt when a closed item is reopened', async () => {
    repo.findByIdForUser.mockResolvedValue(item({ status: 'closed', closedAt: new Date() }));

    await call('item', 'patch', { query: { id: OID_A }, body: { status: 'open' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { status: 'open', closedAt: null });
  });

  it('leaves closedAt alone when the status is unchanged', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { status: 'open', title: 'Renamed' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { title: 'Renamed' });
  });

  it('refuses a self-dependency', async () => {
    await expect(
      call('item', 'patch', { query: { id: OID_A }, body: { dependencies: [OID_A] } }).result
    ).rejects.toThrow(/cannot depend on itself/);
  });

  it('passes the item id to the cycle check so the post-write graph is validated', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([item({ id: OID_B })]);

    await call('item', 'patch', { query: { id: OID_A }, body: { dependencies: [OID_B] } }).result;

    expect(repo.detectDependencyCycle).toHaveBeenCalledWith('u1', [OID_B], OID_A);
  });

  it('404s on an item the caller does not own', async () => {
    repo.findByIdForUser.mockResolvedValue(null);

    await expect(call('item', 'patch', { query: { id: OID_A }, body: { title: 'x' } }).result).rejects.toThrow(
      /not found/i
    );
    expect(repo.updateForUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/work-items/:id', () => {
  it('soft deletes and responds 204', async () => {
    repo.softDeleteForUser.mockResolvedValue(true);

    const { res, result } = call('item', 'delete', { query: { id: OID_A } });
    await result;

    expect(repo.softDeleteForUser).toHaveBeenCalledWith(OID_A, 'u1');
    expect(res._getStatusCode()).toBe(204);
  });

  it('404s when nothing matched', async () => {
    repo.softDeleteForUser.mockResolvedValue(false);

    await expect(call('item', 'delete', { query: { id: OID_A } }).result).rejects.toThrow(/not found/i);
  });
});

describe('GET /api/work-items/ready and /graph', () => {
  it('wraps ready items in a data envelope', async () => {
    repo.listReadyForUser.mockResolvedValue([item()]);

    const { res, result } = call('ready', 'get', {});
    await result;

    expect(repo.listReadyForUser).toHaveBeenCalledWith('u1');
    expect(res._getJSONData()).toMatchObject({ data: [{ id: OID_A }] });
  });

  it('returns the graph for the caller', async () => {
    const graph = { nodes: [{ id: OID_A, title: 'Ship it', status: 'open' }], edges: [], cycles: [] };
    repo.buildGraphForUser.mockResolvedValue(graph);

    const { res, result } = call('graph', 'get', {});
    await result;

    expect(repo.buildGraphForUser).toHaveBeenCalledWith('u1');
    expect(res._getJSONData()).toEqual(graph);
  });
});

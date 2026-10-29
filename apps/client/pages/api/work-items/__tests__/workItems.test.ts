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
  findNextReadyForLoop: vi.fn(),
}));
const loopRepo = vi.hoisted(() => ({ findByIdAndUserId: vi.fn(), makeDueNow: vi.fn() }));
const settings = vi.hoisted(() => ({ EnableLoops: true as unknown }));
vi.mock('@bike4mind/database', () => ({
  workItemRepository: repo,
  loopRepository: loopRepo,
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings[key as 'EnableLoops'] },
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgAccess }));

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

const call = (
  module: string,
  method: 'get' | 'post' | 'patch' | 'delete',
  options: Record<string, unknown>,
  apiKeyInfo?: unknown
) => {
  const { req, res } = createMocks({ method: method.toUpperCase(), ...options } as any);
  (req as any).user = { id: 'u1', isAdmin: false };
  (req as any).apiKeyInfo = apiKeyInfo;
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

  // The filter can only narrow a result set already scoped to the caller's own
  // userId, so gating it would 404 a plain org member without protecting anything.
  it('filters by organization without an org-access check', async () => {
    await call('collection', 'get', { query: { organizationId: 'org1' } }).result;

    expect(verifyOrgAccess).not.toHaveBeenCalled();
    expect(repo.listForUser).toHaveBeenCalledWith(
      'u1',
      { organizationId: 'org1' },
      expect.anything(),
      expect.anything()
    );
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

  // Stored lowercase, not verbatim: `dependencies` is a [String] field, and every
  // consumer compares it against the lowercase `id` virtual, so an uppercase entry would
  // read as a deleted dependency and quietly unblock the item.
  it('accepts an uppercase-hex dependency id and stores the canonical lowercase form', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([item({ id: OID_B })]);

    await call('collection', 'post', { body: { title: 'Ship it', dependencies: [OID_B.toUpperCase()] } }).result;

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ dependencies: [OID_B] }));
  });

  it('dedupes dependency ids that differ only in hex casing', async () => {
    repo.findManyByIdsForUser.mockResolvedValue([item({ id: OID_B })]);

    await call('collection', 'post', {
      body: { title: 'Ship it', dependencies: [OID_B, OID_B.toUpperCase()] },
    }).result;

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ dependencies: [OID_B] }));
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

  // '' and null are the clearing signal; the repository turns a null into $unset.
  it('turns an empty description into the clearing value', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { description: '' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { description: null });
  });

  it('turns an explicit null description into the clearing value', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { description: null } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { description: null });
  });

  it('leaves description alone when the field is absent', async () => {
    await call('item', 'patch', { query: { id: OID_A }, body: { title: 'Renamed' } }).result;

    expect(repo.updateForUser).toHaveBeenCalledWith(OID_A, 'u1', { title: 'Renamed' });
  });

  it('rejects an empty status rather than silently ignoring it', async () => {
    await expect(call('item', 'patch', { query: { id: OID_A }, body: { status: '' } }).result).rejects.toThrow(
      /status must be one of/
    );
    expect(repo.updateForUser).not.toHaveBeenCalled();
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
    repo.listReadyForUser.mockResolvedValue({ data: [item()], truncated: false });

    const { res, result } = call('ready', 'get', {});
    await result;

    expect(repo.listReadyForUser).toHaveBeenCalledWith('u1', undefined);
    expect(res._getJSONData()).toMatchObject({ data: [{ id: OID_A }], truncated: false });
  });

  it('passes the truncation flag through so a partial answer is labelled', async () => {
    repo.listReadyForUser.mockResolvedValue({ data: [item()], truncated: true });

    const { res, result } = call('ready', 'get', {});
    await result;

    expect(res._getJSONData()).toMatchObject({ truncated: true });
  });

  it('returns the graph for the caller', async () => {
    const graph = {
      nodes: [{ id: OID_A, title: 'Ship it', status: 'open' }],
      edges: [],
      cycles: [],
      truncated: false,
    };
    repo.buildGraphForUser.mockResolvedValue(graph);

    const { res, result } = call('graph', 'get', {});
    await result;

    expect(repo.buildGraphForUser).toHaveBeenCalledWith('u1');
    expect(res._getJSONData()).toEqual(graph);
  });
});

describe('loop tickets through the work-items routes', () => {
  const LOOP = '507f1f77bcf86cd799439099';
  const loop = { id: LOOP, userId: 'u1', status: 'live', stages: ['todo', 'doing', 'done'] };

  beforeEach(() => {
    settings.EnableLoops = true;
    loopRepo.findByIdAndUserId.mockImplementation(async (id: string) => (id === LOOP ? loop : null));
    repo.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: OID_B, ...doc }));
    repo.updateForUser.mockImplementation(async (_id: string, _u: string, patch: Record<string, unknown>) => patch);
    repo.findNextReadyForLoop.mockResolvedValue(item({ loopId: LOOP }));
  });

  it('hides loop tickets from a plain listing and returns them with ?loopId=', async () => {
    repo.listForUser.mockResolvedValue({ data: [], hasMore: false, total: 0 });
    await call('collection', 'get', { query: {} }).result;
    expect(repo.listForUser.mock.calls[0][1]).not.toHaveProperty('loopId');

    await call('collection', 'get', { query: { loopId: LOOP } }).result;
    expect(repo.listForUser.mock.calls[1][1]).toMatchObject({ loopId: LOOP });
  });

  it('returns ready tickets of the caller loop from /ready?loopId=, and 404s a foreign loop', async () => {
    repo.listReadyForUser.mockResolvedValue({ data: [], truncated: false });
    await call('ready', 'get', { query: { loopId: LOOP } }).result;
    expect(repo.listReadyForUser).toHaveBeenCalledWith('u1', LOOP);

    await expect(call('ready', 'get', { query: { loopId: OID_A } }).result).rejects.toThrow(/not found/i);
  });

  it('creates a ticket in the first stage and makes the live loop due', async () => {
    const { res, result } = call('collection', 'post', { body: { title: 'T', loopId: LOOP } });
    await result;
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ loopId: LOOP, stage: 'todo', status: 'open' }));
    expect(loopRepo.makeDueNow).toHaveBeenCalledWith(LOOP, expect.any(Date));
    expect(res._getStatusCode()).toBe(201);
  });

  it('creating into the last stage closes the ticket', async () => {
    await call('collection', 'post', { body: { title: 'T', loopId: LOOP, stage: 'done' } }).result;
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'done', status: 'closed', closedAt: expect.any(Date) })
    );
  });

  it('rejects an unknown stage', async () => {
    await expect(
      call('collection', 'post', { body: { title: 'T', loopId: LOOP, stage: 'nope' } }).result
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("is a 404 for another user's loop, for an API key, and with EnableLoops off", async () => {
    const other = '507f1f77bcf86cd799439098';
    await expect(call('collection', 'post', { body: { title: 'T', loopId: other } }).result).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(call('collection', 'get', { query: { loopId: LOOP } }, { id: 'key' }).result).rejects.toMatchObject({
      statusCode: 404,
    });
    settings.EnableLoops = false;
    await expect(call('collection', 'post', { body: { title: 'T', loopId: LOOP } }).result).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('a loop ticket does not exist to an API key', async () => {
    repo.findByIdForUser.mockResolvedValue(item({ loopId: LOOP, stage: 'todo' }));
    for (const method of ['get', 'patch', 'delete'] as const) {
      await expect(
        call('item', method, { query: { id: OID_A }, body: { status: 'closed' } }, { id: 'key' }).result
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(repo.updateForUser).not.toHaveBeenCalled();
    expect(repo.softDeleteForUser).not.toHaveBeenCalled();
  });

  it('moving a ticket to the last stage closes it; reopening puts it back a stage', async () => {
    repo.findByIdForUser.mockResolvedValue(item({ loopId: LOOP, stage: 'doing' }));
    await call('item', 'patch', { query: { id: OID_A }, body: { stage: 'done' } }).result;
    expect(repo.updateForUser).toHaveBeenLastCalledWith(
      OID_A,
      'u1',
      expect.objectContaining({ stage: 'done', status: 'closed', closedAt: expect.any(Date) })
    );

    repo.findByIdForUser.mockResolvedValue(item({ loopId: LOOP, stage: 'done', status: 'closed' }));
    await call('item', 'patch', { query: { id: OID_A }, body: { status: 'open' } }).result;
    expect(repo.updateForUser).toHaveBeenLastCalledWith(
      OID_A,
      'u1',
      expect.objectContaining({ stage: 'doing', status: 'open', closedAt: null })
    );
  });

  it('blocking needs a reason', async () => {
    repo.findByIdForUser.mockResolvedValue(item({ loopId: LOOP, stage: 'todo' }));
    await expect(
      call('item', 'patch', { query: { id: OID_A }, body: { status: 'blocked' } }).result
    ).rejects.toMatchObject({ statusCode: 400 });
    await call('item', 'patch', { query: { id: OID_A }, body: { status: 'blocked', reason: 'waiting on X' } }).result;
    expect(repo.updateForUser).toHaveBeenLastCalledWith(
      OID_A,
      'u1',
      expect.objectContaining({ status: 'blocked', statusReason: 'waiting on X' })
    );
  });

  it('loopId: null turns a ticket back into a plain item', async () => {
    repo.findByIdForUser.mockResolvedValue(item({ loopId: LOOP, stage: 'todo', executionId: 'e1' }));
    await call('item', 'patch', { query: { id: OID_A }, body: { loopId: null } }).result;
    expect(repo.updateForUser).toHaveBeenLastCalledWith(
      OID_A,
      'u1',
      expect.objectContaining({ loopId: null, stage: null, statusReason: null, executionId: null })
    );
  });

  it('loopId: null reopens a running ticket and is a 404 with EnableLoops off', async () => {
    repo.findByIdForUser.mockResolvedValue(
      item({ loopId: LOOP, stage: 'doing', status: 'in_progress', executionId: 'e1' })
    );
    await call('item', 'patch', { query: { id: OID_A }, body: { loopId: null } }).result;
    expect(repo.updateForUser).toHaveBeenLastCalledWith(
      OID_A,
      'u1',
      expect.objectContaining({ loopId: null, executionId: null, status: 'open' })
    );

    repo.updateForUser.mockClear();
    settings.EnableLoops = false;
    await expect(call('item', 'patch', { query: { id: OID_A }, body: { loopId: null } }).result).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repo.updateForUser).not.toHaveBeenCalled();
  });
});

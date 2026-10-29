import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-level tests for /api/loops. The repository is mocked - its own behaviour
 * is covered against a real Mongo in packages/database/src/models/ai/LoopModel.test.ts.
 */

type Handler = (req: any, res: any) => Promise<unknown>;
type Method = 'get' | 'post' | 'patch' | 'delete';

const handlers = vi.hoisted(() => ({}) as Record<string, Partial<Record<Method, Handler>>>);
const currentModule = vi.hoisted(() => ({ name: '' }));
const baseApiOptions = vi.hoisted(() => ({}) as Record<string, unknown>);

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
  return {
    baseApi: (options: unknown) => ((baseApiOptions[currentModule.name] = options), makeChain()),
  };
});

const repo = vi.hoisted(() => ({
  listForUser: vi.fn(),
  findByIdAndUserId: vi.fn(),
  updateForUser: vi.fn(),
  deleteForUser: vi.fn(),
  create: vi.fn(),
}));
const tickets = vi.hoisted(() => ({
  softDeleteByLoop: vi.fn(),
  listForLoop: vi.fn(),
  findManyByIdsForUser: vi.fn(),
}));
const settings = vi.hoisted(() => ({ EnableLoops: true as unknown }));
vi.mock('@bike4mind/database', () => ({
  loopRepository: repo,
  workItemRepository: tickets,
  adminSettingsRepository: {
    getSettingsValue: async (key: string) => settings[key as 'EnableLoops'],
    findAll: async () => [],
  },
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgAccess }));

const getOrCreateSession = vi.hoisted(() => vi.fn());
vi.mock('@server/managers/sessionCrud', () => ({ getOrCreateSession }));

const resolveDefaultChatModel = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/chatCompletionDefaults', () => ({ resolveDefaultChatModel }));

currentModule.name = 'collection';
await import('@pages/api/loops/index');
currentModule.name = 'item';
await import('@pages/api/loops/[id]/index');
currentModule.name = 'run';
await import('@pages/api/loops/[id]/run');
currentModule.name = 'tickets';
await import('@pages/api/loops/[id]/tickets');

const OID = '507f1f77bcf86cd799439011';

const call = (module: string, method: Method, options: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: method.toUpperCase(), ...options } as any);
  (req as any).user = { id: 'u1', isAdmin: false };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, result: handlers[module][method]!(req, res) };
};

const loop = (overrides: Record<string, unknown> = {}) => ({
  id: OID,
  userId: 'u1',
  name: 'Digest',
  goal: 'Summarize',
  model: 'm1',
  sessionId: 's1',
  intervalMinutes: 15,
  tools: [],
  status: 'draft',
  runCount: 0,
  consecutiveFailures: 0,
  memory: { notes: '', nextAction: '' },
  ...overrides,
});

const validBody = { name: 'Digest', goal: 'Summarize the inbox', intervalMinutes: 15 };

beforeEach(() => {
  vi.clearAllMocks();
  settings.EnableLoops = true;
  getOrCreateSession.mockResolvedValue({ sessionId: 's-new' });
  resolveDefaultChatModel.mockResolvedValue({ model: 'default-model' });
  repo.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: OID, ...doc }));
  repo.updateForUser.mockImplementation(async (_id: string, _u: string, patch: Record<string, unknown>) => loop(patch));
});

it.each(['collection', 'item', 'run'])('%s route refuses API keys (jwtOnly)', mod => {
  expect(baseApiOptions[mod]).toEqual({ auth: 'jwtOnly' });
});

describe('EnableLoops gate', () => {
  const routes: Array<[string, Method]> = [
    ['collection', 'get'],
    ['collection', 'post'],
    ['item', 'get'],
    ['item', 'patch'],
    ['item', 'delete'],
    ['run', 'post'],
  ];

  it.each(routes)('%s %s is a 404 while the setting is off, before touching the repository', async (mod, method) => {
    settings.EnableLoops = false;
    await expect(call(mod, method, { query: { id: OID }, body: validBody }).result).rejects.toMatchObject({
      statusCode: 404,
    });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST /api/loops', () => {
  it('creates a draft loop with its own notebook and the default model', async () => {
    const { res, result } = call('collection', 'post', { body: { ...validBody, tools: ['mcp__srv__do_thing'] } });
    await result;

    expect(res._getStatusCode()).toBe(201);
    expect(getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'Digest' }));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        sessionId: 's-new',
        model: 'default-model',
        status: 'draft',
        tools: ['mcp__srv__do_thing'],
      })
    );
  });

  it('keeps an explicit model', async () => {
    await call('collection', 'post', { body: { ...validBody, model: 'claude-x' } }).result;
    expect(resolveDefaultChatModel).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-x' }));
  });

  it.each([
    [{ ...validBody, intervalMinutes: 4 }, /intervalMinutes/],
    [{ ...validBody, intervalMinutes: 7.5 }, /intervalMinutes/],
    [{ ...validBody, name: '' }, /name/],
    [{ ...validBody, goal: 'x'.repeat(8001) }, /goal/],
    [{ ...validBody, tools: 'web_search' }, /tools/],
    [{ ...validBody, tools: Array.from({ length: 51 }, (_, i) => `t${i}`) }, /tools/],
  ])('rejects an invalid body (%#)', async (body, message) => {
    await expect(call('collection', 'post', { body }).result).rejects.toThrow(message);
    expect(repo.create).not.toHaveBeenCalled();
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('stores an organizationId the caller may bill to', async () => {
    verifyOrgAccess.mockResolvedValue(undefined);
    await call('collection', 'post', { body: { ...validBody, organizationId: 'org1' } }).result;
    expect(verifyOrgAccess).toHaveBeenCalledWith({ id: 'u1', isAdmin: false }, 'org1');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org1' }));
  });

  it('rejects a non-string organizationId before creating the notebook', async () => {
    await expect(
      call('collection', 'post', { body: { ...validBody, organizationId: { $ne: null } } }).result
    ).rejects.toThrow(/organizationId/);
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('checks org membership before creating anything', async () => {
    verifyOrgAccess.mockRejectedValue(new Error('not a member'));
    await expect(call('collection', 'post', { body: { ...validBody, organizationId: 'org1' } }).result).rejects.toThrow(
      'not a member'
    );
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('owner scoping', () => {
  it.each<[string, Method]>([
    ['item', 'get'],
    ['item', 'patch'],
    ['item', 'delete'],
    ['run', 'post'],
  ])("%s %s is a 404 for another user's loop", async (mod, method) => {
    repo.findByIdAndUserId.mockResolvedValue(null);
    repo.deleteForUser.mockResolvedValue(false);
    await expect(call(mod, method, { query: { id: OID }, body: {} }).result).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.updateForUser).not.toHaveBeenCalled();
  });

  it('scopes every lookup to the caller', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop());
    await call('item', 'get', { query: { id: OID } }).result;
    expect(repo.findByIdAndUserId).toHaveBeenCalledWith(OID, 'u1');
  });
});

describe('PATCH /api/loops/:id status transitions', () => {
  const patchStatus = async (from: Record<string, unknown>, status: string) => {
    repo.findByIdAndUserId.mockResolvedValue(loop(from));
    await call('item', 'patch', { query: { id: OID }, body: { status } }).result;
    return repo.updateForUser.mock.calls[0][2];
  };

  it('draft -> live schedules the first run now', async () => {
    const before = Date.now();
    const patch = await patchStatus({ status: 'draft' }, 'live');
    expect(patch).toMatchObject({ status: 'live', consecutiveFailures: 0, statusReason: null });
    expect(patch.nextRunAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(patch.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('paused -> live waits out the interval since the last run', async () => {
    const lastRunAt = new Date();
    const patch = await patchStatus({ status: 'paused', lastRunAt }, 'live');
    expect(patch.nextRunAt).toEqual(new Date(lastRunAt.getTime() + 15 * 60_000));
  });

  it('error -> live resets the failure count', async () => {
    const patch = await patchStatus({ status: 'error', consecutiveFailures: 3 }, 'live');
    expect(patch).toMatchObject({ status: 'live', consecutiveFailures: 0 });
  });

  it('live -> paused', async () => {
    expect(await patchStatus({ status: 'live' }, 'paused')).toMatchObject({ status: 'paused' });
  });

  it.each([
    ['draft', 'paused'],
    ['live', 'error'],
    ['live', 'needs_you'],
    ['paused', 'draft'],
  ])('refuses %s -> %s', async (from, to) => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: from }));
    await expect(call('item', 'patch', { query: { id: OID }, body: { status: to } }).result).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(repo.updateForUser).not.toHaveBeenCalled();
  });

  it('needs_you -> live', async () => {
    expect(await patchStatus({ status: 'needs_you' }, 'live')).toMatchObject({ status: 'live' });
  });

  it('writes only while the loop still has the status the patch was computed from', async () => {
    await patchStatus({ status: 'live' }, 'paused');
    expect(repo.updateForUser.mock.calls[0][3]).toBe('live');
  });

  it('is a 409 when the loop changed status mid-request', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: 'live' }));
    repo.updateForUser.mockResolvedValue(null);
    await expect(
      call('item', 'patch', { query: { id: OID }, body: { status: 'paused' } }).result
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('moves the next run of a live loop when its interval changes', async () => {
    const lastRunAt = new Date(Date.now() - 60_000);
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: 'live', lastRunAt }));
    await call('item', 'patch', { query: { id: OID }, body: { intervalMinutes: 60 } }).result;
    expect(repo.updateForUser.mock.calls[0][2].nextRunAt).toEqual(new Date(lastRunAt.getTime() + 60 * 60_000));
  });

  it('clears agentId and budgetCreditsPerDay with null', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ agentId: 'a1', budgetCreditsPerDay: 5 }));
    await call('item', 'patch', { query: { id: OID }, body: { agentId: null, budgetCreditsPerDay: null } }).result;
    expect(repo.updateForUser.mock.calls[0][2]).toEqual({ agentId: null, budgetCreditsPerDay: null });
  });

  it('validates the other fields', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop());
    await expect(call('item', 'patch', { query: { id: OID }, body: { intervalMinutes: 1 } }).result).rejects.toThrow(
      /intervalMinutes/
    );
  });
});

describe('POST /api/loops/:id/run', () => {
  it('makes a live loop due now', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: 'live' }));
    await call('run', 'post', { query: { id: OID } }).result;
    expect(repo.updateForUser).toHaveBeenCalledWith(OID, 'u1', { nextRunAt: expect.any(Date) }, 'live');
  });

  it('is a 409 when the loop stopped being live mid-request', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: 'live' }));
    repo.updateForUser.mockResolvedValue(null);
    await expect(call('run', 'post', { query: { id: OID } }).result).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is a 409 for a loop that is not live', async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ status: 'paused' }));
    await expect(call('run', 'post', { query: { id: OID } }).result).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('DELETE /api/loops/:id', () => {
  it('deletes the caller loop', async () => {
    repo.deleteForUser.mockResolvedValue(true);
    const { res, result } = call('item', 'delete', { query: { id: OID } });
    await result;
    expect(repo.deleteForUser).toHaveBeenCalledWith(OID, 'u1');
    expect(tickets.softDeleteByLoop).toHaveBeenCalledWith('u1', OID);
    expect(res._getStatusCode()).toBe(204);
  });
});

describe('GET /api/loops/:id/tickets', () => {
  const ticket = (overrides: Record<string, unknown>) => ({
    id: 't',
    title: 'T',
    status: 'open',
    dependencies: [],
    updatedAt: new Date(),
    ...overrides,
  });

  it('is session-only', () => {
    expect(baseApiOptions.tickets).toEqual({ auth: 'jwtOnly' });
  });

  it("groups tickets by the loop's stage order and marks readiness", async () => {
    repo.findByIdAndUserId.mockResolvedValue(loop({ stages: ['todo', 'doing', 'done'] }));
    tickets.listForLoop.mockResolvedValue([
      ticket({ id: 'a', stage: 'doing' }),
      ticket({ id: 'b', stage: 'todo', dependencies: ['a'] }),
      ticket({ id: 'c', stage: 'done', status: 'closed' }),
      ticket({ id: 'd', stage: 'removed-stage' }),
    ]);
    tickets.findManyByIdsForUser.mockResolvedValue([ticket({ id: 'a', status: 'open' })]);

    const { res, result } = call('tickets', 'get', { query: { id: OID } });
    await result;

    const { stages } = res._getJSONData();
    expect(stages.map((group: { stage: string }) => group.stage)).toEqual(['todo', 'doing', 'done']);
    expect(stages[0].tickets.map((t: { id: string; ready: boolean }) => [t.id, t.ready])).toEqual([
      ['b', false],
      ['d', true],
    ]);
    expect(stages[1].tickets[0]).toMatchObject({ id: 'a', ready: true });
    expect(stages[2].tickets[0]).toMatchObject({ id: 'c', ready: false });
    expect(tickets.listForLoop).toHaveBeenCalledWith('u1', OID, 50);
  });

  it("is a 404 for another user's loop", async () => {
    repo.findByIdAndUserId.mockResolvedValue(null);
    await expect(call('tickets', 'get', { query: { id: OID } }).result).rejects.toMatchObject({ statusCode: 404 });
  });

  it('is a 404 when EnableLoops is off', async () => {
    settings.EnableLoops = false;
    try {
      await expect(call('tickets', 'get', { query: { id: OID } }).result).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      settings.EnableLoops = true;
    }
  });
});

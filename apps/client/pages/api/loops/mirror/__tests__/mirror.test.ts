import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod, type RequestOptions } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Method = 'get' | 'put' | 'delete';

const handlers = vi.hoisted(() => ({}) as Record<string, Partial<Record<Method, Handler>>>);
const currentModule = vi.hoisted(() => ({ name: '' }));
const baseApiOptions = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('@server/middlewares/baseApi', () => {
  const makeChain = () => {
    const slot = (handlers[currentModule.name] ??= {});
    const chain: Record<string, (fn: Handler) => unknown> = {
      use: () => chain,
      get: (fn: Handler) => ((slot.get = fn), chain),
      put: (fn: Handler) => ((slot.put = fn), chain),
      delete: (fn: Handler) => ((slot.delete = fn), chain),
    };
    return chain;
  };
  return { baseApi: (options: unknown) => ((baseApiOptions[currentModule.name] = options), makeChain()) };
});

const settings = vi.hoisted(() => ({ EnableLoops: true as unknown }));
const mirror = vi.hoisted(() => ({
  upsert: vi.fn(),
  exists: vi.fn(async () => false),
  countForUser: vi.fn(async () => 0),
  remove: vi.fn(),
  listForUser: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@bike4mind/database', () => ({
  loopMirrorRepository: mirror,
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings[key as keyof typeof settings] },
}));

currentModule.name = 'one';
await import('@pages/api/loops/mirror/[localLoopId]');
currentModule.name = 'list';
await import('@pages/api/loops/mirror/index');

const LOOP_ID = '0b7d6c1e-2f4a-4d7e-9c1b-3a5e8f9d0c21';
const snapshot = {
  name: 'Docs',
  status: 'live',
  idleReason: 'no work',
  stages: ['todo', 'done'],
  lanesBusy: 0,
  lanes: 2,
  spentToday: 3,
  needsYou: 0,
  tickets: [{ title: 'Fix the guide', stage: 'todo', status: 'open', priority: 'p1' }],
};

const call = async (route: string, method: Method, options: RequestOptions = {}) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as RequestMethod, ...options });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn() } });
  await handlers[route][method]!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.EnableLoops = true;
});

describe('/api/loops/mirror', () => {
  it('serves a first-party session only (no API keys)', () => {
    expect(baseApiOptions.one).toEqual({ auth: 'jwtOnly' });
    expect(baseApiOptions.list).toEqual({ auth: 'jwtOnly' });
  });

  it("stores a valid snapshot under the caller's id", async () => {
    const res = await call('one', 'put', { query: { localLoopId: LOOP_ID }, body: snapshot });
    expect(res._getJSONData()).toEqual({ ok: true });
    expect(mirror.upsert).toHaveBeenCalledWith('u1', LOOP_ID, snapshot, expect.any(Date));
  });

  it('refuses a snapshot carrying anything beyond the status fields', async () => {
    await expect(
      call('one', 'put', { query: { localLoopId: LOOP_ID }, body: { ...snapshot, goal: 'secret plans' } })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      call('one', 'put', {
        query: { localLoopId: LOOP_ID },
        body: { ...snapshot, tickets: [{ ...snapshot.tickets[0], description: 'private' }] },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mirror.upsert).not.toHaveBeenCalled();
  });

  it('refuses a malformed loop id and a new loop past the per-user cap', async () => {
    await expect(call('one', 'put', { query: { localLoopId: 'x' }, body: snapshot })).rejects.toMatchObject({
      statusCode: 400,
    });
    mirror.countForUser.mockResolvedValueOnce(50);
    await expect(call('one', 'put', { query: { localLoopId: LOOP_ID }, body: snapshot })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mirror.upsert).not.toHaveBeenCalled();
  });

  it("deletes the caller's row and lists only the caller's loops", async () => {
    await call('one', 'delete', { query: { localLoopId: LOOP_ID } });
    expect(mirror.remove).toHaveBeenCalledWith('u1', LOOP_ID);
    mirror.listForUser.mockResolvedValueOnce([{ localLoopId: LOOP_ID, snapshot, lastSeenAt: new Date(0) }]);
    const res = await call('list', 'get');
    expect(mirror.listForUser).toHaveBeenCalledWith('u1');
    expect(res._getJSONData().loops).toHaveLength(1);
  });

  it('is a 404 while EnableLoops is off', async () => {
    settings.EnableLoops = false;
    await expect(call('one', 'put', { query: { localLoopId: LOOP_ID }, body: snapshot })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(call('list', 'get')).rejects.toMatchObject({ statusCode: 404 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-level tests for /api/loops/runner: auth mode, the feature gate, body validation and the
 * `{ error, reason }` refusals. The runner logic itself runs against a real Mongo in
 * server/utils/loopRunner.e2e.test.ts.
 */

type Handler = (req: any, res: any) => Promise<unknown>;

const handlers = vi.hoisted(() => ({}) as Record<string, Partial<Record<'get' | 'post', Handler>>>);
const currentModule = vi.hoisted(() => ({ name: '' }));
const baseApiOptions = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('@server/middlewares/baseApi', () => {
  const makeChain = () => {
    const slot = (handlers[currentModule.name] ??= {});
    const chain: any = {
      use: () => chain,
      get: (fn: Handler) => ((slot.get = fn), chain),
      post: (fn: Handler) => ((slot.post = fn), chain),
    };
    return chain;
  };
  return { baseApi: (options: unknown) => ((baseApiOptions[currentModule.name] = options), makeChain()) };
});

const settings = vi.hoisted(() => ({ EnableLoops: true as unknown }));
const presence = vi.hoisted(() => ({ upsertForUser: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  loopRunnerPresenceRepository: presence,
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings[key as keyof typeof settings] },
  loopRepository: {},
}));

const runner = vi.hoisted(() => ({
  listRunnerTickets: vi.fn(),
  claimRunnerTicket: vi.fn(),
  heartbeatRunnerRun: vi.fn(),
  progressRunnerRun: vi.fn(),
  completeRunnerRun: vi.fn(),
}));
vi.mock('@server/utils/loopRunner', () => ({
  ...runner,
  isRefusal: (value: unknown) => !!value && typeof value === 'object' && 'status' in value && 'reason' in value,
}));

currentModule.name = 'tickets';
await import('@pages/api/loops/runner/tickets');
currentModule.name = 'claim';
await import('@pages/api/loops/runner/claim');
currentModule.name = 'presence';
await import('@pages/api/loops/runner/presence');
currentModule.name = 'run';
await import('@pages/api/loops/runner/runs/[runId]/[action]');

const call = async (route: string, method: 'get' | 'post', options: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: method.toUpperCase(), ...options } as any);
  (req as any).user = { id: 'u1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  await handlers[route][method]!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.EnableLoops = true;
});

describe('/api/loops/runner', () => {
  it('serves every route to a first-party session only (no API keys)', () => {
    for (const route of ['tickets', 'claim', 'presence', 'run']) {
      expect(baseApiOptions[route]).toEqual({ auth: 'jwtOnly' });
    }
  });

  it('is a 404 on every route while EnableLoops is off', async () => {
    settings.EnableLoops = false;
    await expect(call('tickets', 'get')).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('claim', 'post', { body: { ticketId: 't1' } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('presence', 'post', { body: { lanesBusy: 0, lanesFree: 1 } })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(call('run', 'post', { query: { runId: 'r1', action: 'heartbeat' }, body: {} })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(runner.listRunnerTickets).not.toHaveBeenCalled();
    expect(runner.heartbeatRunnerRun).not.toHaveBeenCalled();
  });

  it("lists the caller's tickets", async () => {
    runner.listRunnerTickets.mockResolvedValue([{ ticketId: 't1' }]);
    const res = await call('tickets', 'get');
    expect(res._getJSONData()).toEqual({ tickets: [{ ticketId: 't1' }] });
    expect(runner.listRunnerTickets).toHaveBeenCalledWith('u1', expect.any(Date));
  });

  it('answers a refused claim with its status and reason, and a good one with the claim', async () => {
    runner.claimRunnerTicket.mockResolvedValueOnce({ status: 409, reason: 'claimed', error: 'Claimed already' });
    const refused = await call('claim', 'post', { body: { ticketId: 't1' } });
    expect(refused._getStatusCode()).toBe(409);
    expect(refused._getJSONData()).toEqual({ error: 'Claimed already', reason: 'claimed' });

    runner.claimRunnerTicket.mockResolvedValueOnce({ runId: 'r1' });
    expect((await call('claim', 'post', { body: { ticketId: 't1' } }))._getJSONData()).toEqual({ runId: 'r1' });
    await expect(call('claim', 'post', { body: {} })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('maps heartbeat, progress and complete, and answers a lost lease with 410', async () => {
    runner.heartbeatRunnerRun.mockResolvedValue({ status: 410, reason: 'lease_lost', error: 'The lease lapsed' });
    const lost = await call('run', 'post', { query: { runId: 'r1', action: 'heartbeat' }, body: {} });
    expect(lost._getStatusCode()).toBe(410);
    expect(lost._getJSONData()).toEqual({ error: 'The lease lapsed', reason: 'lease_lost' });

    const frames = [{ type: 'text', text: 'hi' }];
    runner.progressRunnerRun.mockResolvedValue({ leaseExpiresAt: 'later' });
    const progressed = await call('run', 'post', { query: { runId: 'r1', action: 'progress' }, body: { frames } });
    expect(progressed._getJSONData()).toEqual({ leaseExpiresAt: 'later' });
    expect(runner.progressRunnerRun).toHaveBeenCalledWith('u1', 'r1', frames, expect.any(Date), expect.anything());

    runner.completeRunnerRun.mockResolvedValue({ ok: true });
    const body = { outcome: 'failed', reason: 'crashed', durationMs: 10 };
    expect((await call('run', 'post', { query: { runId: 'r1', action: 'complete' }, body }))._getJSONData()).toEqual({
      ok: true,
    });
    expect(runner.completeRunnerRun).toHaveBeenCalledWith('u1', 'r1', body, expect.any(Date), expect.anything());

    await expect(call('run', 'post', { query: { runId: 'r1', action: 'nope' }, body: {} })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it.each([
    ['progress', { frames: Array.from({ length: 201 }, () => ({ type: 'text', text: 'x' })) }],
    ['progress', { frames: [{ type: 'text', text: 'x'.repeat(4001) }] }],
    ['progress', { frames: [{ type: 'shout', text: 'x' }] }],
    ['complete', { outcome: 'advanced', durationMs: 1 }],
    ['complete', { outcome: 'blocked', durationMs: 1 }],
    ['complete', { outcome: 'won', durationMs: 1 }],
  ])('rejects a bad %s body with a 400 (%#)', async (action, body) => {
    await expect(call('run', 'post', { query: { runId: 'r1', action }, body })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(runner.progressRunnerRun).not.toHaveBeenCalled();
    expect(runner.completeRunnerRun).not.toHaveBeenCalled();
  });

  it('records presence, dropping a blank waiting reason', async () => {
    await call('presence', 'post', { body: { lanesBusy: 1, lanesFree: 3, waitingReason: '  ' } });
    expect(presence.upsertForUser).toHaveBeenCalledWith('u1', { seenAt: expect.any(Date), lanesBusy: 1, lanesFree: 3 });
    await expect(call('presence', 'post', { body: { lanesBusy: -1, lanesFree: 3 } })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

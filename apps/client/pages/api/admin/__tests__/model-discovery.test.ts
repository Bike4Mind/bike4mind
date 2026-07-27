import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware stripped so the handler body runs directly (same pattern as
// __tests__/model-deprecation-status.test.ts). The chain object doubles as the
// exported handler and dispatches on req.method.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    return chain;
  },
}));

const { latestRun, lastSuccessfulRun, getSettingsValue, lambdaSend, runScheduledDiscovery, resource } = vi.hoisted(
  () => ({
    latestRun: vi.fn(),
    lastSuccessfulRun: vi.fn(),
    getSettingsValue: vi.fn(),
    lambdaSend: vi.fn(async () => ({ StatusCode: 202 })),
    runScheduledDiscovery: vi.fn(async () => ({ outcome: 'ok' })),
    resource: { lambdaFunctionNames: { modelDiscovery: 'dev-model-discovery-fn' } } as {
      lambdaFunctionNames?: Record<string, string | undefined>;
    },
  })
);

vi.mock('@bike4mind/database', () => ({
  modelDiscoveryRunRepository: { latestRun, lastSuccessfulRun },
  adminSettingsRepository: { getSettingsValue },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));
vi.mock('sst', () => ({ Resource: resource }));
vi.mock('@server/modelDiscovery/scheduledRun', () => ({ runScheduledDiscovery }));

import handler from '../model-discovery';

const STARTED_AT = new Date('2026-07-26T12:00:00Z');
const FINISHED_AT = new Date('2026-07-26T12:03:00Z');

const RUN = {
  id: 'run-1',
  startedAt: STARTED_AT,
  finishedAt: FINISHED_AT,
  trigger: 'cron',
  host: 'hosted',
  status: 'partial',
  sources: [
    { name: 'openai', ok: true, durationMs: 120, httpStatus: 200, etag: 'W/"abc"' },
    { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
  ],
  joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
  unmatchedIds: ['a', 'b', 'c'],
  changes: { added: ['m1', 'm2'], promoted: ['m1'], flagged: [] },
  createdAt: STARTED_AT,
  updatedAt: FINISHED_AT,
};

function call(options: { method: 'GET' | 'POST'; isAdmin?: boolean }) {
  const { req, res } = createMocks({ method: options.method });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { run: () => handler(req as never, res as never), res };
}

describe('/api/admin/model-discovery', () => {
  const selfHostFlag = process.env.B4M_SELF_HOST;

  beforeEach(() => {
    vi.clearAllMocks();
    resource.lambdaFunctionNames = { modelDiscovery: 'dev-model-discovery-fn' };
    delete process.env.B4M_SELF_HOST;
    latestRun.mockResolvedValue(RUN);
    lastSuccessfulRun.mockResolvedValue({ ...RUN, startedAt: new Date('2026-07-26T06:00:00Z'), status: 'ok' });
    getSettingsValue.mockImplementation(async (key: string) => (key === 'modelDiscoveryMode' ? 'write' : 'manual'));
  });

  afterEach(() => {
    if (selfHostFlag === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = selfHostFlag;
  });

  it.each(['GET', 'POST'] as const)('rejects a non-admin %s', async method => {
    const { run } = call({ method, isAdmin: false });
    await expect(run()).rejects.toThrow('Admin access required');
  });

  it('returns the trimmed last run, the settings and the deployment kind', async () => {
    const { run, res } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData()).toEqual({
      lastRun: {
        startedAt: STARTED_AT.toISOString(),
        finishedAt: FINISHED_AT.toISOString(),
        trigger: 'cron',
        host: 'hosted',
        status: 'partial',
        sources: [
          { name: 'openai', ok: true, durationMs: 120 },
          { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
        ],
        joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
        changes: { added: 2, promoted: 1, deprecated: 0, repriced: 0, flagged: 0 },
      },
      lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
      mode: 'write',
      autoEnable: 'manual',
      selfHost: false,
    });
  });

  it('reports the setting defaults and a null run before discovery has ever run', async () => {
    latestRun.mockResolvedValue(null);
    lastSuccessfulRun.mockResolvedValue(null);
    getSettingsValue.mockResolvedValue(undefined);

    const { run, res } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData()).toMatchObject({
      lastRun: null,
      lastSuccessfulRunAt: null,
      mode: 'report',
      autoEnable: 'priced',
    });
  });

  it('async-invokes the discovery function with a manual trigger on hosted', async () => {
    const { run, res } = call({ method: 'POST' });
    await run();

    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ dispatched: 'lambda' });
    const command = lambdaSend.mock.calls[0][0] as unknown as { FunctionName: string; Payload: Buffer };
    expect(command.FunctionName).toBe('dev-model-discovery-fn');
    expect(JSON.parse(command.Payload.toString())).toEqual({ trigger: 'manual' });
  });

  it('dispatches in-process on self-host', async () => {
    process.env.B4M_SELF_HOST = 'true';

    const { run, res } = call({ method: 'POST' });
    await run();

    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ dispatched: 'in-process' });
    expect(runScheduledDiscovery).toHaveBeenCalledWith(expect.anything(), 'selfhost', { trigger: 'manual' });
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('answers 503 when the discovery function is not linked', async () => {
    resource.lambdaFunctionNames = undefined;

    const { run, res } = call({ method: 'POST' });
    await run();

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().message).toMatch(/not linked/);
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});

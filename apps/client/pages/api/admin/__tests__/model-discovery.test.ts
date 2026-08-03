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

const { recentRuns, runById, lastSuccessfulRun, getSettingsValue, lambdaSend, runScheduledDiscovery, resource } =
  vi.hoisted(() => ({
    recentRuns: vi.fn(),
    runById: vi.fn(),
    lastSuccessfulRun: vi.fn(),
    getSettingsValue: vi.fn(),
    lambdaSend: vi.fn(async () => ({ StatusCode: 202 })),
    runScheduledDiscovery: vi.fn(async () => ({ outcome: 'ok' })),
    resource: { lambdaFunctionNames: { modelDiscovery: 'dev-model-discovery-fn' } } as {
      lambdaFunctionNames?: Record<string, string | undefined>;
    },
  }));

vi.mock('@bike4mind/database', () => ({
  modelDiscoveryRunRepository: { recentRuns, runById, lastSuccessfulRun },
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
// The real module pulls the whole discovery source registry in; only its gate matters here.
vi.mock('@server/modelDiscovery/startupLeg', () => ({
  DISCOVERY_DRIVER_ENV: 'B4M_DISCOVERY_DRIVER',
  isDiscoveryDriver: () => process.env.B4M_DISCOVERY_DRIVER === 'true',
}));

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

/** The same run as the report reads it: the detail behind every count. */
const DETAILED_RUN = {
  ...RUN,
  passes: 3,
  sources: [
    { name: 'openai', ok: true, durationMs: 120, httpStatus: 200, recordCount: 61, etag: 'W/"abc"' },
    { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT', parserRows: { pricing: 30 } },
  ],
  changes: {
    added: ['m1', 'm2'],
    promoted: ['m1'],
    flagged: ['m3', 'gpt-5.6-luna'],
    operatorConflicts: ['m3'],
    plannedRows: 4,
    appendedRows: 4,
  },
  priceFlags: [
    {
      modelId: 'gpt-5.6-luna',
      kind: 'source-disagreement',
      proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
      sources: ['models.dev', 'litellm'],
      detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
    },
  ],
  priceOverrides: [
    {
      modelId: 'gpt-5.6-terra',
      source: 'openai',
      dissenting: ['litellm'],
      applied: { inputPerMTok: 2, outputPerMTok: 12 },
      detail: 'openai publishes in 2/out 12 $/MTok and litellm in 8/out 24 $/MTok disagree beyond 10%',
    },
  ],
  priceSkips: [{ modelId: 'm1', reason: 'unchanged' }],
  lifecycleTransitions: [{ modelId: 'm4', from: 'active', to: 'deprecated', signal: 'absence', autoApplied: false }],
  droppedRecords: [{ source: 'litellm', modelId: 'ghost-1', reason: 'unknown backend' }],
};

function call(options: {
  method: 'GET' | 'POST';
  isAdmin?: boolean;
  // string[] covers a repeated query parameter, which is a request the route rejects.
  query?: Record<string, string | string[]>;
}) {
  const { req, res } = createMocks({ method: options.method, query: options.query });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { run: () => handler(req as never, res as never), res };
}

describe('/api/admin/model-discovery', () => {
  const selfHostFlag = process.env.B4M_SELF_HOST;
  const driverFlag = process.env.B4M_DISCOVERY_DRIVER;

  beforeEach(() => {
    vi.clearAllMocks();
    resource.lambdaFunctionNames = { modelDiscovery: 'dev-model-discovery-fn' };
    delete process.env.B4M_SELF_HOST;
    process.env.B4M_DISCOVERY_DRIVER = 'true';
    recentRuns.mockResolvedValue([RUN]);
    runById.mockResolvedValue(DETAILED_RUN);
    lastSuccessfulRun.mockResolvedValue({ ...RUN, startedAt: new Date('2026-07-26T06:00:00Z'), status: 'ok' });
    getSettingsValue.mockImplementation(async (key: string) => (key === 'modelDiscoveryMode' ? 'write' : 'manual'));
  });

  afterEach(() => {
    if (selfHostFlag === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = selfHostFlag;
    if (driverFlag === undefined) delete process.env.B4M_DISCOVERY_DRIVER;
    else process.env.B4M_DISCOVERY_DRIVER = driverFlag;
  });

  it.each(['GET', 'POST'] as const)('rejects a non-admin %s', async method => {
    const { run } = call({ method, isAdmin: false });
    await expect(run()).rejects.toThrow('Admin access required');
  });

  it('rejects a non-admin asking for one run by id', async () => {
    const { run } = call({ method: 'GET', isAdmin: false, query: { runId: 'run-1' } });
    await expect(run()).rejects.toThrow('Admin access required');
    expect(runById).not.toHaveBeenCalled();
  });

  it('returns the trimmed last run, the run list, the settings and the deployment kind', async () => {
    const { run, res } = call({ method: 'GET' });
    await run();

    const listed = {
      id: 'run-1',
      startedAt: STARTED_AT.toISOString(),
      finishedAt: FINISHED_AT.toISOString(),
      trigger: 'cron',
      host: 'hosted',
      status: 'partial',
      changes: { added: 2, promoted: 1, deprecated: 0, repriced: 0, flagged: 0 },
    };
    expect(res._getJSONData()).toEqual({
      lastRun: {
        ...listed,
        sources: [
          { name: 'openai', ok: true, durationMs: 120 },
          { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
        ],
        joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
      },
      // The head of the list is the run the card shows, and the id is what the
      // client opens the report with.
      runs: [listed],
      lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
      enabled: true,
      mode: 'write',
      autoEnable: 'manual',
      selfHost: false,
    });
    expect(recentRuns).toHaveBeenCalledWith(20);
  });

  it('reports the setting defaults, a null run and an empty list before discovery has ever run', async () => {
    recentRuns.mockResolvedValue([]);
    lastSuccessfulRun.mockResolvedValue(null);
    getSettingsValue.mockResolvedValue(undefined);

    const { run, res } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData()).toMatchObject({
      lastRun: null,
      runs: [],
      lastSuccessfulRunAt: null,
      enabled: true,
      mode: 'report',
      autoEnable: 'priced',
    });
  });

  it('returns one run in full, with the change ids rather than their counts', async () => {
    const { run, res } = call({ method: 'GET', query: { runId: 'run-1' } });
    await run();

    expect(runById).toHaveBeenCalledWith('run-1');
    expect(res._getJSONData()).toEqual({
      run: {
        id: 'run-1',
        startedAt: STARTED_AT.toISOString(),
        finishedAt: FINISHED_AT.toISOString(),
        trigger: 'cron',
        host: 'hosted',
        status: 'partial',
        passes: 3,
        // No etag, contentHash or parserRows: those belong to the run-over-run
        // parser-shift guard, not to an operator.
        sources: [
          { name: 'openai', ok: true, durationMs: 120, httpStatus: 200, recordCount: 61 },
          { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
        ],
        joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
        changes: {
          added: ['m1', 'm2'],
          promoted: ['m1'],
          deprecated: [],
          repriced: [],
          flagged: ['m3', 'gpt-5.6-luna'],
          operatorConflicts: ['m3'],
          plannedRows: 4,
          appendedRows: 4,
          plannedPriceRows: 0,
          appendedPriceRows: 0,
        },
        priceFlags: [
          {
            modelId: 'gpt-5.6-luna',
            kind: 'source-disagreement',
            proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
            sources: ['models.dev', 'litellm'],
            detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
          },
        ],
        // Absent on the document, defaulted here: the client never guards for
        // undefined.
        priceRows: [],
        priceOverrides: [
          {
            modelId: 'gpt-5.6-terra',
            source: 'openai',
            dissenting: ['litellm'],
            applied: { inputPerMTok: 2, outputPerMTok: 12 },
            detail: 'openai publishes in 2/out 12 $/MTok and litellm in 8/out 24 $/MTok disagree beyond 10%',
          },
        ],
        priceSkips: [{ modelId: 'm1', reason: 'unchanged' }],
        lifecycleTransitions: [
          { modelId: 'm4', from: 'active', to: 'deprecated', signal: 'absence', autoApplied: false },
        ],
        catalogDiff: [],
        // Empty because this run truncated nothing; a total appears per array only
        // when the runner cut it.
        detailTotals: {},
        unmatchedIds: ['a', 'b', 'c'],
        droppedRecords: [{ source: 'litellm', modelId: 'ghost-1', reason: 'unknown backend' }],
      },
    });
  });

  it('reports the mode each run itself ran in, not the mode the setting holds now', async () => {
    // The setting says 'write' (see beforeEach) while these runs ran in report
    // mode. Reading the setting instead would tell the report that a plan nobody
    // wrote should have landed.
    runById.mockResolvedValue({ ...DETAILED_RUN, mode: 'report' });
    recentRuns.mockResolvedValue([{ ...RUN, mode: 'report' }]);

    const detail = call({ method: 'GET', query: { runId: 'run-1' } });
    await detail.run();
    expect(detail.res._getJSONData().run.mode).toBe('report');

    const list = call({ method: 'GET' });
    await list.run();
    const listed = list.res._getJSONData();
    expect(listed.lastRun.mode).toBe('report');
    expect(listed.runs[0].mode).toBe('report');
    expect(listed.mode).toBe('write');
  });

  it('passes the truncation totals through so a section can say it shows the first 200 of N', async () => {
    runById.mockResolvedValue({ ...DETAILED_RUN, detailTotals: { priceFlags: 260, catalogDiff: 301 } });

    const { run, res } = call({ method: 'GET', query: { runId: 'run-1' } });
    await run();

    expect(res._getJSONData().run.detailTotals).toEqual({ priceFlags: 260, catalogDiff: 301 });
  });

  it('answers 404 for a run id that matches nothing', async () => {
    runById.mockResolvedValue(null);

    // NotFoundError so the standard envelope answers it (name/error/request_id),
    // which is the shape every client here already reads.
    const { run } = call({ method: 'GET', query: { runId: 'nope' } });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(recentRuns).not.toHaveBeenCalled();
  });

  it('rejects a repeated runId instead of quietly answering the status list', async () => {
    // ?runId=a&runId=b arrives as an array; falling through to the list would look
    // like a successful report fetch.
    const { run } = call({ method: 'GET', query: { runId: ['a', 'b'] } });

    await expect(run()).rejects.toThrow(/single value/i);
    expect(runById).not.toHaveBeenCalled();
    expect(recentRuns).not.toHaveBeenCalled();
  });

  it('reports the master switch as off so the card can say why nothing will run', async () => {
    getSettingsValue.mockImplementation(async (key: string) => (key === 'enableModelDiscovery' ? false : 'report'));

    const { run, res } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData()).toMatchObject({ enabled: false });
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

  it('refuses with 409 instead of dispatching a run the service would skip', async () => {
    getSettingsValue.mockImplementation(async (key: string) => (key === 'enableModelDiscovery' ? false : 'report'));

    const { run, res } = call({ method: 'POST' });
    await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'discovery-disabled' });
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(runScheduledDiscovery).not.toHaveBeenCalled();
  });

  it('answers 503 on self-host when this process is not a discovery driver', async () => {
    process.env.B4M_SELF_HOST = 'true';
    delete process.env.B4M_DISCOVERY_DRIVER;

    const { run, res } = call({ method: 'POST' });
    await run();

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().message).toMatch(/B4M_DISCOVERY_DRIVER=true/);
    expect(runScheduledDiscovery).not.toHaveBeenCalled();
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

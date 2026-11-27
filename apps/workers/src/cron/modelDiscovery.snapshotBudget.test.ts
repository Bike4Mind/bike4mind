import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  run: vi.fn(),
  rows: vi.fn(),
  send: vi.fn(async (_command: unknown, _options?: { abortSignal?: AbortSignal }) => undefined),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  metrics: vi.fn(async () => undefined),
  failure: vi.fn(async () => undefined),
}));
vi.mock('@bike4mind/database', () => ({ connectDB: mocks.connect, modelPriceRepository: { rowsInForce: mocks.rows } }));
vi.mock('@bike4mind/services', () => ({ modelDiscoveryService: { DEFAULT_BUDGET_MS: 600_000 } }));
vi.mock('@bike4mind/server-utils/modelDiscovery/scheduledRun', () => ({ runScheduledDiscovery: mocks.run }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://unused/%STAGE%' } }));
vi.mock('@workers/modelDiscovery/metrics', () => ({
  emitDiscoveryMetrics: mocks.metrics,
  emitDiscoveryRunFailure: mocks.failure,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = mocks.info;
    warn = mocks.warn;
    error = mocks.error;
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ createS3Client: () => ({ send: mocks.send }) }));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

// The actual hosted driver and actual snapshot writer share the real budget helper.
const { handler } = await import('./modelDiscovery');
const NOW = new Date('2026-11-01T00:00:00Z');
const context = { getRemainingTimeInMillis: () => 100_000 } as Context;
const result = {
  outcome: 'ok',
  runId: 'run-1',
  mode: 'report',
  metrics: { ModelsDiscovered: 1, ModelsPromoted: 0, ModelsBlockedByDispatch: 0, RunDuration: 1 },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred value was not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred value was not initialized');
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function observe(promise: ReturnType<typeof handler>) {
  const state: { settled: boolean; value: unknown; error: unknown } = {
    settled: false,
    value: undefined,
    error: undefined,
  };
  const completed = (async () => {
    try {
      state.value = await promise;
    } catch (error) {
      state.error = error;
    } finally {
      state.settled = true;
    }
  })();
  return { state, completed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
  mocks.connect.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue(result);
  mocks.rows.mockResolvedValue([]);
  mocks.send.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('discovery with the actual optional snapshot publisher', () => {
  it.each(['success', 'original failure'] as const)(
    'settles its %s while a snapshot DB read is pending',
    async outcome => {
      const original = new Error('original discovery error');
      if (outcome === 'original failure') mocks.run.mockRejectedValueOnce(original);
      const rows = deferred<unknown[]>();
      mocks.rows.mockReturnValueOnce(rows.promise);
      const observed = observe(handler({}, context));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.rows).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_001);
        expect(observed.state.settled).toBe(true);
        if (outcome === 'original failure') expect(observed.state.error).toBe(original);
        else
          expect(observed.state.value).toEqual({
            statusCode: 200,
            body: JSON.stringify({ outcome: 'ok', runId: 'run-1' }),
          });
        expect(mocks.send).not.toHaveBeenCalled();
      } finally {
        rows.resolve([]);
        await observed.completed;
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'original failure'] as const)(
    'settles its %s while an optional Put is pending',
    async outcome => {
      const original = new Error('original discovery error');
      if (outcome === 'original failure') mocks.run.mockRejectedValueOnce(original);
      const put = deferred<undefined>();
      mocks.send.mockReturnValueOnce(put.promise);
      const observed = observe(handler({}, context));
      try {
        await vi.advanceTimersByTimeAsync(0);
        const signal = mocks.send.mock.calls[0][1]?.abortSignal;
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(observed.state.settled).toBe(true);
        expect(signal?.aborted).toBe(true);
        if (outcome === 'original failure') expect(observed.state.error).toBe(original);
        else expect(observed.state.value).toMatchObject({ statusCode: 200 });
        put.reject(new Error('late S3 rejection'));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        put.resolve(undefined);
        await observed.completed;
      }
    }
  );

  it('clips the optional writer to the headroom left by the invocation', async () => {
    const rows = deferred<unknown[]>();
    mocks.rows.mockReturnValueOnce(rows.promise);
    const observed = observe(handler({}, { ...context, getRemainingTimeInMillis: () => 62_000 }));
    try {
      await vi.advanceTimersByTimeAsync(2_001);
      expect(observed.state.settled).toBe(true);
      expect(observed.state.value).toMatchObject({ statusCode: 200 });
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      rows.resolve([]);
      await observed.completed;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('preserves discovery headroom by skipping optional publication near the hard stop', async () => {
    await expect(handler({}, { ...context, getRemainingTimeInMillis: () => 60_000 })).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(mocks.rows).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

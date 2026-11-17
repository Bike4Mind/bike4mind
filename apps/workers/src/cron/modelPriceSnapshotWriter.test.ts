import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_command: unknown, _options?: { abortSignal?: AbortSignal }) => undefined),
  rowsInForce: vi.fn(),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({ createS3Client: () => ({ send: mocks.send }) }));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));
vi.mock('@bike4mind/database', () => ({ modelPriceRepository: { rowsInForce: mocks.rowsInForce } }));

const { publishModelPriceSnapshot } = await import('./modelPriceSnapshotWriter');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-10-31T12:20:00.000Z');
const tier = { 272_000: { input: 1e-6, output: 4e-6 } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.send.mockResolvedValue(undefined);
  mocks.rowsInForce.mockResolvedValue([
    { modelId: 'gpt-6-astra', unit: 'per_token', pricing: tier },
    { modelId: 'gpt-realtime', unit: 'per_minute', pricing: tier },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('publishModelPriceSnapshot', () => {
  it('writes the per-token rows as JSON to the snapshot key', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    await publishModelPriceSnapshot(logger as unknown as Logger, NOW);

    const { input } = mocks.send.mock.calls[0][0] as { input: Record<string, string> };
    expect(input).toMatchObject({
      Bucket: 'snapshot-bucket',
      Key: 'model-prices/per-token.json',
      ContentType: 'application/json',
    });
    expect(JSON.parse(input.Body)).toEqual({
      version: 1,
      generatedAt: NOW.toISOString(),
      rows: [{ modelId: 'gpt-6-astra', pricing: { '272000': tier[272_000] } }],
    });
  });

  it('does nothing when the bucket is not configured', async () => {
    await publishModelPriceSnapshot(logger as unknown as Logger, NOW);
    expect(mocks.rowsInForce).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and resolves when the upload fails', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    mocks.send.mockRejectedValueOnce(new Error('access denied'));
    await expect(publishModelPriceSnapshot(logger as unknown as Logger, NOW)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('logs and resolves when the rows cannot be read', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    mocks.rowsInForce.mockRejectedValueOnce(new Error('mongo down'));
    await expect(publishModelPriceSnapshot(logger as unknown as Logger, NOW)).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

function deferredPublication<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred publication was not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred publication was not initialized');
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('optional snapshot publication deadlines', () => {
  it('returns after a pending DB read and never starts a late upload', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    const rows = deferredPublication<unknown[]>();
    mocks.rowsInForce.mockReturnValueOnce(rows.promise);
    const state = { settled: false };
    const publication = (async () => {
      await publishModelPriceSnapshot(logger as unknown as Logger, NOW);
      state.settled = true;
    })();
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(state.settled).toBe(true);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      rows.resolve([{ modelId: 'gpt-6-astra', unit: 'per_token', pricing: tier }]);
      await publication;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('checks the absolute deadline before uploading even if the timer callback has not run', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    const rows = deferredPublication<unknown[]>();
    mocks.rowsInForce.mockReturnValueOnce(rows.promise);
    const publication = publishModelPriceSnapshot(logger as unknown as Logger, NOW);
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    rows.resolve([{ modelId: 'gpt-6-astra', unit: 'per_token', pricing: tier }]);
    await publication;
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('aborts a pending Put and observes its late rejection without logging success', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    const put = deferredPublication<undefined>();
    mocks.send.mockReturnValueOnce(put.promise);
    const state = { settled: false };
    const publication = (async () => {
      await publishModelPriceSnapshot(logger as unknown as Logger, NOW);
      state.settled = true;
    })();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const signal = mocks.send.mock.calls[0][1]?.abortSignal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(state.settled).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(logger.info).not.toHaveBeenCalled();
      put.reject(new Error('late upload failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      put.resolve(undefined);
      await publication;
    }
  });

  it('does not read rows when its caller deadline is already expired', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
    await publishModelPriceSnapshot(logger as unknown as Logger, NOW, { deadlineMs: Date.now() });
    expect(mocks.rowsInForce).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

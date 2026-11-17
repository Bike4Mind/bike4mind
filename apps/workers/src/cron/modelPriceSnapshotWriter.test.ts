import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_command: unknown) => undefined),
  rowsInForce: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.send;
  },
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
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.send.mockResolvedValue(undefined);
  mocks.rowsInForce.mockResolvedValue([
    { modelId: 'gpt-6-astra', unit: 'per_token', pricing: tier },
    { modelId: 'gpt-realtime', unit: 'per_minute', pricing: tier },
  ]);
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

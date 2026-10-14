import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectDB, lastSuccessfulRun, send, loggerError } = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
  lastSuccessfulRun: vi.fn(),
  send: vi.fn(async (_command: unknown) => undefined),
  loggerError: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = send;
  },
  PutMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
  StandardUnit: { Count: 'Count' },
}));
vi.mock('@bike4mind/database', () => ({
  connectDB,
  modelDiscoveryRunRepository: { lastSuccessfulRun },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    error = loggerError;
  },
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));

const { handler, isModelDiscoveryStale, MODEL_DISCOVERY_STALE_AFTER_MS } = await import('./modelDiscoveryStaleness');
const now = new Date('2026-10-08T12:00:00.000Z');

function publishedValue(): number {
  const command = send.mock.calls[0]?.[0] as { input: { MetricData: Array<{ Value: number }> } } | undefined;
  if (!command) throw new Error('no metric was published');
  return command.input.MetricData[0].Value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  lastSuccessfulRun.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('model discovery staleness check', () => {
  it('changes to stale exactly 24 hours after the last completion', () => {
    expect(isModelDiscoveryStale(new Date(now.getTime() - MODEL_DISCOVERY_STALE_AFTER_MS + 1), now)).toBe(false);
    expect(isModelDiscoveryStale(new Date(now.getTime() - MODEL_DISCOVERY_STALE_AFTER_MS), now)).toBe(true);
    expect(isModelDiscoveryStale(null, now)).toBe(true);
  });

  it('publishes healthy for a recently completed hosted ok run', async () => {
    lastSuccessfulRun.mockResolvedValue({
      startedAt: new Date('2026-10-07T11:00:00.000Z'),
      finishedAt: new Date('2026-10-07T12:01:00.000Z'),
    });

    await handler();

    expect(lastSuccessfulRun).toHaveBeenCalledExactlyOnceWith('hosted');
    expect(publishedValue()).toBe(0);
    const command = send.mock.calls[0][0] as { input: unknown };
    expect(command.input).toMatchObject({
      Namespace: 'Lumina5/ModelDiscovery',
      MetricData: [
        {
          MetricName: 'NoSuccessfulRun',
          Value: 0,
          Unit: 'Count',
          Dimensions: [
            { Name: 'Stage', Value: 'dev' },
            { Name: 'Host', Value: 'hosted' },
          ],
        },
      ],
    });
  });

  it('publishes stale after the discovery cron stops for more than 24 hours', async () => {
    lastSuccessfulRun.mockResolvedValue({ finishedAt: new Date('2026-10-07T11:59:00.000Z') });
    await handler();
    expect(publishedValue()).toBe(1);
  });

  it('publishes stale when no successful run exists', async () => {
    await handler();
    expect(publishedValue()).toBe(1);
  });

  it('uses startedAt for older successful records without finishedAt', async () => {
    lastSuccessfulRun.mockResolvedValue({ startedAt: new Date('2026-10-07T11:59:00.000Z') });
    await handler();
    expect(publishedValue()).toBe(1);
  });

  it('does not publish a healthy value when database connection fails', async () => {
    connectDB.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(handler()).rejects.toThrow('database unavailable');
    expect(lastSuccessfulRun).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledOnce();
  });

  it('does not publish a healthy value when the database read fails', async () => {
    lastSuccessfulRun.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(handler()).rejects.toThrow('database unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledOnce();
  });

  it('fails loudly when metric publication fails', async () => {
    send.mockRejectedValueOnce(new Error('CloudWatch unavailable'));
    await expect(handler()).rejects.toThrow('CloudWatch unavailable');
    expect(loggerError).toHaveBeenCalledOnce();
  });
});

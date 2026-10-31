import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_command: unknown) => undefined),
  fetchAnthropicHourlyUsage: vi.fn(),
  fetchOpenAIHourlyUsage: vi.fn(),
  priceProviderUsage: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  config: {
    ANTHROPIC_ADMIN_API_KEY: 'anthropic-admin-key' as string | undefined,
    OPENAI_ADMIN_API_KEY: 'openai-admin-key' as string | undefined,
  },
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = mocks.send;
  },
  PutMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));
vi.mock('@bike4mind/services', () => ({
  spendReconciliationService: {
    fetchAnthropicHourlyUsage: mocks.fetchAnthropicHourlyUsage,
    fetchOpenAIHourlyUsage: mocks.fetchOpenAIHourlyUsage,
    priceProviderUsage: mocks.priceProviderUsage,
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return this;
    }
    info = mocks.info;
    warn = mocks.warn;
    error = mocks.error;
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config }));
vi.mock('sst', () => ({ Resource: { App: { name: 'test-app', stage: 'production' } } }));

const { handler, previousHourWindow } = await import('./providerUsagePoll');

const NOW = new Date('2026-10-31T14:07:23.456Z');
const START = new Date('2026-10-31T13:00:00.000Z');
const END = new Date('2026-10-31T14:00:00.000Z');
const context = { awsRequestId: 'req-1', functionName: 'poller', functionVersion: '1' } as Context;

const usageRow = (model: string) => ({
  bucketStart: START,
  model,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

type PutInput = { Namespace: string; MetricData: Array<Record<string, unknown>> };
const published = (): PutInput => {
  const command = mocks.send.mock.calls[0]?.[0] as { input: PutInput } | undefined;
  if (!command) throw new Error('no metrics were published');
  return command.input;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.config.ANTHROPIC_ADMIN_API_KEY = 'anthropic-admin-key';
  mocks.config.OPENAI_ADMIN_API_KEY = 'openai-admin-key';
  mocks.fetchAnthropicHourlyUsage.mockResolvedValue([usageRow('claude-opus-5-5-20260901'), usageRow('claude-x')]);
  mocks.fetchOpenAIHourlyUsage.mockResolvedValue([usageRow('gpt-5.5')]);
  mocks.priceProviderUsage.mockImplementation(async (provider: string) =>
    provider === 'anthropic'
      ? { usd: 42.5, outputTokens: 40, unpricedOutputTokens: 20, unpricedModels: ['claude-x'] }
      : { usd: 3.25, outputTokens: 20, unpricedOutputTokens: 0, unpricedModels: [] }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('previousHourWindow', () => {
  it('is the last complete UTC hour', () => {
    expect(previousHourWindow(NOW)).toEqual({ start: START, end: END });
  });

  it('treats a run exactly on the hour as the end of the previous hour', () => {
    expect(previousHourWindow(END)).toEqual({ start: START, end: END });
  });
});

describe('providerUsagePoll handler', () => {
  it('reads the previous hour from both providers with their own time formats', async () => {
    await handler({}, context);
    expect(mocks.fetchAnthropicHourlyUsage).toHaveBeenCalledExactlyOnceWith(
      'anthropic-admin-key',
      '2026-10-31T13:00:00.000Z',
      '2026-10-31T14:00:00.000Z'
    );
    expect(mocks.fetchOpenAIHourlyUsage).toHaveBeenCalledExactlyOnceWith(
      'openai-admin-key',
      START.getTime() / 1000,
      END.getTime() / 1000
    );
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith('anthropic', expect.any(Array));
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith('openai', [usageRow('gpt-5.5')]);
  });

  it('publishes USD, output tokens and unpriced tokens per provider, stamped at run time', async () => {
    const result = await handler({}, context);
    expect(result).toEqual({ published: 2, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);

    const datum = (provider: string, MetricName: string, Value: number, Unit: string) => ({
      MetricName,
      Value,
      Unit,
      Dimensions: [{ Name: 'Provider', Value: provider }],
      Timestamp: NOW,
    });
    expect(published()).toEqual({
      Namespace: 'test-app/production/LLMSpend',
      MetricData: [
        datum('anthropic', 'ProviderReportedUsd', 42.5, 'None'),
        datum('anthropic', 'ProviderReportedOutputTokens', 40, 'Count'),
        datum('anthropic', 'UnpricedOutputTokens', 20, 'Count'),
        datum('openai', 'ProviderReportedUsd', 3.25, 'None'),
        datum('openai', 'ProviderReportedOutputTokens', 20, 'Count'),
        datum('openai', 'UnpricedOutputTokens', 0, 'Count'),
      ],
    });
  });

  it('logs one info line per provider and one warn line for unpriced models', async () => {
    await handler({}, context);
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.info.mock.calls[0][0]).toBe(
      '[ProviderUsagePoll] anthropic 2026-10-31T13:00:00.000Z..2026-10-31T14:00:00.000Z: usd=$42.50 outputTokens=40 models=2'
    );
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      '[ProviderUsagePoll] anthropic: no price for claude-x (20 output tokens)'
    );
  });

  it.each([undefined, '', 'not-configured'])('skips a provider whose admin key is %j', async key => {
    mocks.config.OPENAI_ADMIN_API_KEY = key;
    const result = await handler({}, context);

    expect(result).toEqual({ published: 1, skipped: 1 });
    expect(mocks.fetchOpenAIHourlyUsage).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith('[ProviderUsagePoll] openai: admin key not configured, skipping');
    const providers = published().MetricData.map(d => (d.Dimensions as Array<{ Value: string }>)[0].Value);
    expect(new Set(providers)).toEqual(new Set(['anthropic']));
  });

  it('publishes nothing when no provider is configured', async () => {
    mocks.config.ANTHROPIC_ADMIN_API_KEY = undefined;
    mocks.config.OPENAI_ADMIN_API_KEY = 'not-configured';
    expect(await handler({}, context)).toEqual({ published: 0, skipped: 2 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('publishes the providers that worked, then fails the run for the one that did not', async () => {
    mocks.fetchAnthropicHourlyUsage.mockRejectedValue(new Error('Anthropic API 401: bad key'));

    await expect(handler({}, context)).rejects.toThrow('usage report failed for anthropic');
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const metrics = published().MetricData;
    expect(metrics).toHaveLength(3);
    expect(metrics.every(d => (d.Dimensions as Array<{ Value: string }>)[0].Value === 'openai')).toBe(true);
  });
});

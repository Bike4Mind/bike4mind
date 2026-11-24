import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_command: unknown) => undefined),
  s3Send: vi.fn(
    async (
      _command: unknown,
      _options?: { abortSignal?: AbortSignal }
    ): Promise<{ Body?: { transformToString: () => Promise<string> } }> => ({})
  ),
  secretSend: vi.fn(async (_command: unknown): Promise<{ SecretString?: string; CreatedDate?: Date }> => ({})),
  fetchAnthropicHourlyUsage: vi.fn(),
  fetchOpenAIHourlyUsage: vi.fn(),
  priceProviderUsage: vi.fn(),
  readProviderSpendScope: vi.fn(async (_provider: string): Promise<object | undefined> => undefined),
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
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  GetObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = mocks.secretSend;
  },
  GetSecretValueCommand: class {
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
vi.mock('./providerSpendScope', async importOriginal => ({
  ...(await importOriginal<typeof import('./providerSpendScope')>()),
  readProviderSpendScope: mocks.readProviderSpendScope,
}));
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
  inScope: true,
});

type PutInput = { Namespace: string; MetricData: Array<Record<string, unknown>> };
const published = (): PutInput => {
  const command = mocks.send.mock.calls[0]?.[0] as { input: PutInput } | undefined;
  if (!command) throw new Error('no metrics were published');
  return command.input;
};

const FRESH_AGE_HOURS = (5 * 3600 + 7 * 60 + 23.456) / 3600;
const SNAPSHOT_METRICS = ['ModelPriceSnapshotAgeHours', 'ModelPriceSnapshotMissing'];
const isSnapshotMetric = (d: Record<string, unknown>) => SNAPSHOT_METRICS.includes(d.MetricName as string);
const providerData = () => published().MetricData.filter(d => !isSnapshotMetric(d));
const snapshotData = () => published().MetricData.filter(isSnapshotMetric);
const snapshotDatum = (MetricName: string, Value: number, Unit: string) => ({
  MetricName,
  Value,
  Unit,
  Timestamp: NOW,
});

const snapshotBody = (overrides: Record<string, unknown> = {}) => ({
  Body: {
    transformToString: async () =>
      JSON.stringify({
        version: 1,
        generatedAt: '2026-10-31T09:00:00.000Z',
        rows: [{ modelId: 'gpt-6-astra', pricing: { '272000': { input: 1e-6, output: 4e-6 } } }],
        ...overrides,
      }),
  },
});

beforeEach(() => {
  vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', 'snapshot-bucket');
  mocks.s3Send.mockResolvedValue(snapshotBody());
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.config.ANTHROPIC_ADMIN_API_KEY = 'anthropic-admin-key';
  mocks.config.OPENAI_ADMIN_API_KEY = 'openai-admin-key';
  mocks.fetchAnthropicHourlyUsage.mockResolvedValue([usageRow('claude-opus-5-5-20260901'), usageRow('claude-x')]);
  mocks.fetchOpenAIHourlyUsage.mockResolvedValue([usageRow('gpt-5.5')]);
  mocks.readProviderSpendScope.mockImplementation(async () => undefined);
  mocks.priceProviderUsage.mockImplementation(async (provider: string) =>
    provider === 'anthropic'
      ? { usd: 42.5, outputTokens: 40, unpricedOutputTokens: 20, unpricedModels: ['claude-x'] }
      : { usd: 3.25, outputTokens: 20, unpricedOutputTokens: 0, unpricedModels: [] }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
      '2026-10-31T14:00:00.000Z',
      undefined
    );
    expect(mocks.fetchOpenAIHourlyUsage).toHaveBeenCalledExactlyOnceWith(
      'openai-admin-key',
      START.getTime() / 1000,
      END.getTime() / 1000,
      undefined
    );
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith(
      'anthropic',
      expect.any(Array),
      undefined,
      expect.objectContaining({ version: 1 })
    );
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith(
      'openai',
      [usageRow('gpt-5.5')],
      undefined,
      expect.objectContaining({ version: 1 })
    );
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
        datum('anthropic', 'ProviderReportedOrgUsd', 42.5, 'None'),
        datum('anthropic', 'ProviderReportedOutputTokens', 40, 'Count'),
        datum('anthropic', 'UnpricedOutputTokens', 20, 'Count'),
        datum('openai', 'ProviderReportedUsd', 3.25, 'None'),
        datum('openai', 'ProviderReportedOrgUsd', 3.25, 'None'),
        datum('openai', 'ProviderReportedOutputTokens', 20, 'Count'),
        datum('openai', 'UnpricedOutputTokens', 0, 'Count'),
        snapshotDatum('ModelPriceSnapshotAgeHours', FRESH_AGE_HOURS, 'None'),
        snapshotDatum('ModelPriceSnapshotMissing', 0, 'Count'),
      ],
    });
  });

  it('logs one info line per provider and one warn line for unpriced models', async () => {
    await handler({}, context);
    expect(mocks.info).toHaveBeenCalledTimes(3);
    expect(mocks.info.mock.calls[1][0]).toBe(
      '[ProviderUsagePoll] anthropic 2026-10-31T13:00:00.000Z..2026-10-31T14:00:00.000Z: usd=$42.50 orgUsd=$42.50 scope=org outputTokens=40 models=2'
    );
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      '[ProviderUsagePoll] anthropic: no price for claude-x (20 output tokens)'
    );
  });

  it('publishes the scoped spend as ProviderReportedUsd and the whole organization as ProviderReportedOrgUsd', async () => {
    const scope = { workspaceIds: ['wrkspc_prod'] };
    mocks.readProviderSpendScope.mockImplementation(async provider => (provider === 'anthropic' ? scope : undefined));
    const inside = usageRow('claude-opus-5-5-20260901');
    const outside = { ...usageRow('claude-opus-5-5-20260901'), inScope: false };
    mocks.fetchAnthropicHourlyUsage.mockResolvedValue([inside, outside]);
    mocks.priceProviderUsage.mockImplementation(async (provider: string, rows: unknown[]) =>
      provider === 'anthropic'
        ? { usd: rows.length * 10, outputTokens: rows.length * 20, unpricedOutputTokens: 0, unpricedModels: [] }
        : { usd: 3.25, outputTokens: 20, unpricedOutputTokens: 0, unpricedModels: [] }
    );

    await handler({}, context);

    expect(mocks.fetchAnthropicHourlyUsage).toHaveBeenCalledWith(
      'anthropic-admin-key',
      expect.any(String),
      expect.any(String),
      scope
    );
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith('anthropic', [inside], undefined, expect.anything());
    expect(mocks.priceProviderUsage).toHaveBeenCalledWith('anthropic', [inside, outside], undefined, expect.anything());
    const anthropicValue = (name: string) =>
      providerData().find(
        d => d.MetricName === name && (d.Dimensions as Array<{ Value: string }>)[0].Value === 'anthropic'
      )?.Value;
    expect(anthropicValue('ProviderReportedUsd')).toBe(10);
    expect(anthropicValue('ProviderReportedOutputTokens')).toBe(20);
    expect(anthropicValue('ProviderReportedOrgUsd')).toBe(20);
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('usd=$10.00 orgUsd=$20.00 scope=workspaceIds:1'));
  });

  it('fails a provider whose scope cannot be read instead of reporting the whole organization', async () => {
    mocks.readProviderSpendScope.mockImplementation(async provider => {
      if (provider === 'openai') throw new Error('openai spend scope is not valid JSON');
      return undefined;
    });

    await expect(handler({}, context)).rejects.toThrow('usage report failed for openai');

    expect(mocks.fetchOpenAIHourlyUsage).not.toHaveBeenCalled();
    expect(providerData().some(d => (d.Dimensions as Array<{ Value: string }>)[0].Value === 'openai')).toBe(false);
  });

  const skippedDatum = (provider: string) => ({
    MetricName: 'ProviderUsagePollSkipped',
    Value: 1,
    Unit: 'Count',
    Dimensions: [{ Name: 'Provider', Value: provider }],
    Timestamp: NOW,
  });

  it.each([undefined, '', 'not-configured'])('skips a provider whose admin key is %j', async key => {
    mocks.config.OPENAI_ADMIN_API_KEY = key;
    const result = await handler({}, context);

    expect(result).toEqual({ published: 1, skipped: 1 });
    expect(mocks.fetchOpenAIHourlyUsage).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith('[ProviderUsagePoll] openai: admin key not configured, skipping');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const metrics = providerData();
    expect(metrics.filter(d => d.MetricName === 'ProviderUsagePollSkipped')).toEqual([skippedDatum('openai')]);
    const spendProviders = metrics
      .filter(d => d.MetricName !== 'ProviderUsagePollSkipped')
      .map(d => (d.Dimensions as Array<{ Value: string }>)[0].Value);
    expect(new Set(spendProviders)).toEqual(new Set(['anthropic']));
  });

  it('publishes only skipped data and the snapshot metrics, in one call, when no provider is configured', async () => {
    mocks.config.ANTHROPIC_ADMIN_API_KEY = undefined;
    mocks.config.OPENAI_ADMIN_API_KEY = 'not-configured';
    expect(await handler({}, context)).toEqual({ published: 0, skipped: 2 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(published()).toEqual({
      Namespace: 'test-app/production/LLMSpend',
      MetricData: [
        skippedDatum('anthropic'),
        skippedDatum('openai'),
        snapshotDatum('ModelPriceSnapshotAgeHours', FRESH_AGE_HOURS, 'None'),
        snapshotDatum('ModelPriceSnapshotMissing', 0, 'Count'),
      ],
    });
  });

  it('publishes no key age datum for keys read from Config', async () => {
    await handler({}, context);
    expect(published().MetricData.some(d => d.MetricName === 'ProviderAdminKeyAgeDays')).toBe(false);
  });

  it('publishes no skipped datum when every provider is configured', async () => {
    await handler({}, context);
    expect(published().MetricData.some(d => d.MetricName === 'ProviderUsagePollSkipped')).toBe(false);
  });

  it('publishes the providers that worked, then fails the run for the one that did not', async () => {
    mocks.fetchAnthropicHourlyUsage.mockRejectedValue(new Error('Anthropic API 401: bad key'));

    await expect(handler({}, context)).rejects.toThrow('usage report failed for anthropic');
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const metrics = providerData();
    expect(metrics).toHaveLength(4);
    expect(metrics.every(d => (d.Dimensions as Array<{ Value: string }>)[0].Value === 'openai')).toBe(true);
  });

  describe('with the admin key secret store', () => {
    const storedKeys: Record<string, string | Error> = {};
    const createdDates: Record<string, Date | undefined> = {};
    const secretIds = { anthropic: 'anthropic-secret-arn', openai: 'openai-secret-arn' };

    beforeEach(() => {
      vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC', secretIds.anthropic);
      vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_OPENAI', secretIds.openai);
      storedKeys[secretIds.anthropic] = 'stored-anthropic-key';
      storedKeys[secretIds.openai] = 'stored-openai-key';
      createdDates[secretIds.anthropic] = undefined;
      createdDates[secretIds.openai] = undefined;
      mocks.secretSend.mockImplementation(async command => {
        const secretId = (command as { input: { SecretId: string } }).input.SecretId;
        const value = storedKeys[secretId];
        if (value instanceof Error) throw value;
        return { SecretString: value, CreatedDate: createdDates[secretId] };
      });
    });

    const DAY_MS = 86_400_000;
    const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const ageData = () => published().MetricData.filter(d => d.MetricName === 'ProviderAdminKeyAgeDays');
    const ageDatum = (provider: string, Value: number) => ({
      MetricName: 'ProviderAdminKeyAgeDays',
      Value,
      Unit: 'None',
      Dimensions: [{ Name: 'Provider', Value: provider }],
      Timestamp: NOW,
    });

    it('publishes the age in days of each key version, in the same namespace as the spend metrics', async () => {
      createdDates[secretIds.anthropic] = daysBefore(50);
      createdDates[secretIds.openai] = daysBefore(80.5);

      expect(await handler({}, context)).toEqual({ published: 2, skipped: 0 });

      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(published().Namespace).toBe('test-app/production/LLMSpend');
      expect(ageData()).toEqual([ageDatum('anthropic', 50), ageDatum('openai', 80.5)]);
      expect(providerData()).toHaveLength(10);
    });

    it('publishes an age of zero for a version dated after the run started', async () => {
      createdDates[secretIds.anthropic] = new Date(NOW.getTime() + 5_000);

      await handler({}, context);

      expect(ageData()).toEqual([ageDatum('anthropic', 0)]);
    });

    it('publishes no age datum when the store reports no creation date', async () => {
      await handler({}, context);
      expect(ageData()).toEqual([]);
    });

    it.each([
      ['has no value yet', Object.assign(new Error('no current value'), { name: 'ResourceNotFoundException' })],
      ['holds the placeholder', 'not-configured'],
    ])('publishes no age datum for a skipped provider whose secret %s', async (_label, stored) => {
      createdDates[secretIds.anthropic] = daysBefore(50);
      createdDates[secretIds.openai] = daysBefore(80);
      storedKeys[secretIds.openai] = stored;

      expect(await handler({}, context)).toEqual({ published: 1, skipped: 1 });

      expect(ageData()).toEqual([ageDatum('anthropic', 50)]);
    });

    it('publishes no age datum for a provider whose key lookup failed', async () => {
      createdDates[secretIds.anthropic] = daysBefore(50);
      createdDates[secretIds.openai] = daysBefore(80);
      storedKeys[secretIds.anthropic] = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });

      await expect(handler({}, context)).rejects.toThrow('usage report failed for anthropic');

      expect(ageData()).toEqual([ageDatum('openai', 80)]);
    });

    it('still publishes the age when the usage report for that key fails', async () => {
      createdDates[secretIds.anthropic] = daysBefore(50);
      mocks.fetchAnthropicHourlyUsage.mockRejectedValue(new Error('Anthropic API 401: bad key'));

      await expect(handler({}, context)).rejects.toThrow('usage report failed for anthropic');

      expect(ageData()).toEqual([ageDatum('anthropic', 50)]);
    });

    it('reads each key from its secret and never from Config', async () => {
      await handler({}, context);

      expect(mocks.fetchAnthropicHourlyUsage).toHaveBeenCalledWith(
        'stored-anthropic-key',
        expect.any(String),
        expect.any(String),
        undefined
      );
      expect(mocks.fetchOpenAIHourlyUsage).toHaveBeenCalledWith(
        'stored-openai-key',
        expect.any(Number),
        expect.any(Number),
        undefined
      );
    });

    it('skips a provider whose secret has no value yet, with the usual skipped datum', async () => {
      storedKeys[secretIds.openai] = Object.assign(new Error('no current value'), {
        name: 'ResourceNotFoundException',
      });

      expect(await handler({}, context)).toEqual({ published: 1, skipped: 1 });
      expect(mocks.warn).toHaveBeenCalledWith('[ProviderUsagePoll] openai: admin key not configured, skipping');
      expect(published().MetricData.filter(d => d.MetricName === 'ProviderUsagePollSkipped')).toEqual([
        skippedDatum('openai'),
      ]);
    });

    it('counts a failed key lookup as a failed provider and still publishes the other one', async () => {
      storedKeys[secretIds.anthropic] = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });

      await expect(handler({}, context)).rejects.toThrow('usage report failed for anthropic');

      expect(mocks.fetchAnthropicHourlyUsage).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledTimes(1);
      expect(mocks.warn).not.toHaveBeenCalledWith('[ProviderUsagePoll] anthropic: admin key not configured, skipping');
      const metrics = providerData();
      expect(metrics).toHaveLength(4);
      expect(metrics.every(d => (d.Dimensions as Array<{ Value: string }>)[0].Value === 'openai')).toBe(true);
    });
  });
});

describe('providerUsagePoll model price snapshot', () => {
  const snapshotArg = () => mocks.priceProviderUsage.mock.calls[0][3];
  const staticPricing = () => {
    expect(mocks.priceProviderUsage).toHaveBeenCalledTimes(2);
    for (const call of mocks.priceProviderUsage.mock.calls) expect(call[3]).toBeUndefined();
  };

  it('loads the snapshot once before the provider loop and logs its age and size', async () => {
    await handler({}, context);
    expect(mocks.s3Send).toHaveBeenCalledOnce();
    expect((mocks.s3Send.mock.calls[0][0] as { input: unknown }).input).toEqual({
      Bucket: 'snapshot-bucket',
      Key: 'model-prices/per-token.json',
    });
    expect(snapshotArg()).toMatchObject({ rows: [{ modelId: 'gpt-6-astra' }] });
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('generatedAt=2026-10-31T09:00:00.000Z rows=1'));
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('snapshot'), expect.anything());
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('snapshot'));
  });

  it('warns when the snapshot is older than 24h but still uses it', async () => {
    mocks.s3Send.mockResolvedValue(snapshotBody({ generatedAt: '2026-10-30T13:00:00.000Z' }));
    await handler({}, context);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('stale or implausible'));
    expect(snapshotArg()).toBeDefined();
  });

  it('warns when the snapshot is dated in the future but still uses it', async () => {
    mocks.s3Send.mockResolvedValue(snapshotBody({ generatedAt: '2026-11-03T00:00:00.000Z' }));
    await handler({}, context);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('stale or implausible'));
    expect(snapshotArg()).toBeDefined();
  });

  describe('snapshot age metrics', () => {
    const age = () => snapshotData().filter(d => d.MetricName === 'ModelPriceSnapshotAgeHours');
    const missing = () => snapshotData().filter(d => d.MetricName === 'ModelPriceSnapshotMissing');

    it('publishes the age in hours and Missing=0 for a fresh snapshot, without dimensions', async () => {
      await handler({}, context);
      expect(published().Namespace).toBe('test-app/production/LLMSpend');
      expect(age()).toEqual([snapshotDatum('ModelPriceSnapshotAgeHours', FRESH_AGE_HOURS, 'None')]);
      expect(missing()).toEqual([snapshotDatum('ModelPriceSnapshotMissing', 0, 'Count')]);
      for (const d of snapshotData()) expect(d).not.toHaveProperty('Dimensions');
    });

    it('publishes the age of a stale snapshot, still logging the staleness warning', async () => {
      mocks.s3Send.mockResolvedValue(
        snapshotBody({ generatedAt: new Date(NOW.getTime() - 60 * 3_600_000).toISOString() })
      );
      await handler({}, context);
      expect(age()).toEqual([snapshotDatum('ModelPriceSnapshotAgeHours', 60, 'None')]);
      expect(missing()[0].Value).toBe(0);
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('stale or implausible'));
    });

    it('clamps small forward clock skew to an age of zero', async () => {
      mocks.s3Send.mockResolvedValue(
        snapshotBody({ generatedAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() })
      );
      await handler({}, context);
      expect(age()[0].Value).toBe(0);
      expect(missing()[0].Value).toBe(0);
    });

    it.each([
      [
        'the object is missing',
        () => mocks.s3Send.mockRejectedValue(Object.assign(new Error('x'), { name: 'NoSuchKey' })),
      ],
      ['the bucket is not configured', () => vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', '')],
      [
        'the snapshot fails parsing',
        () => mocks.s3Send.mockResolvedValue({ Body: { transformToString: async () => 'nope' } }),
      ],
    ])('publishes Missing=1 and no age when %s', async (_label, arrange) => {
      arrange();
      await handler({}, context);
      expect(age()).toEqual([]);
      expect(missing()).toEqual([snapshotDatum('ModelPriceSnapshotMissing', 1, 'Count')]);
      for (const d of snapshotData()) expect(d).not.toHaveProperty('Dimensions');
    });

    it.each([
      ['unparseable', 'not a date'],
      ['more than an hour in the future', '2026-11-03T00:00:00.000Z'],
    ])('publishes Missing=1 and no age when generatedAt is %s', async (_label, generatedAt) => {
      mocks.s3Send.mockResolvedValue(snapshotBody({ generatedAt }));
      await handler({}, context);
      expect(age()).toEqual([]);
      expect(missing()).toEqual([snapshotDatum('ModelPriceSnapshotMissing', 1, 'Count')]);
    });

    it('publishes the snapshot metrics even when a provider fails the run', async () => {
      mocks.fetchAnthropicHourlyUsage.mockRejectedValue(new Error('Anthropic API 401: bad key'));
      mocks.fetchOpenAIHourlyUsage.mockRejectedValue(new Error('OpenAI API 401: bad key'));
      await expect(handler({}, context)).rejects.toThrow('usage report failed');
      expect(snapshotData()).toHaveLength(2);
    });
  });

  it('prices from the static tables with one warning when the bucket is not configured', async () => {
    vi.stubEnv('MODEL_PRICE_SNAPSHOT_BUCKET', '');
    await handler({}, context);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    staticPricing();
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot bucket not configured'));
  });

  it('prices from the static tables when the object is missing', async () => {
    mocks.s3Send.mockRejectedValue(Object.assign(new Error('no such key'), { name: 'NoSuchKey' }));
    await expect(handler({}, context)).resolves.toEqual({ published: 2, skipped: 0 });
    staticPricing();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot unavailable'), expect.any(Error));
  });

  it.each([
    ['not JSON', async () => 'nope'],
    ['the wrong shape', async () => JSON.stringify({ version: 2, rows: [] })],
  ])('prices from the static tables when the snapshot is %s', async (_label, transformToString) => {
    mocks.s3Send.mockResolvedValue({ Body: { transformToString } });
    await expect(handler({}, context)).resolves.toEqual({ published: 2, skipped: 0 });
    staticPricing();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot unavailable'), expect.anything());
  });
});

function deferredSnapshot<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred snapshot was not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred snapshot was not initialized');
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function observePoll(promise: ReturnType<typeof handler>) {
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

describe('optional model price snapshot budget', () => {
  const assertFallback = () => {
    expect(mocks.priceProviderUsage).toHaveBeenCalledTimes(2);
    for (const call of mocks.priceProviderUsage.mock.calls) expect(call[3]).toBeUndefined();
    expect(
      mocks.warn.mock.calls.filter(call => typeof call[0] === 'string' && call[0].includes('snapshot unavailable'))
    ).toHaveLength(1);
  };

  it('bounds pending headers, aborts the SDK and disposes a response arriving after fallback', async () => {
    const headers = deferredSnapshot<{ Body?: { transformToString: () => Promise<string> } }>();
    mocks.s3Send.mockReturnValueOnce(headers.promise);
    const transform = vi.fn(async () => '{}');
    const body = Object.assign(new Readable({ read() {} }), { transformToString: transform });
    const observed = observePoll(handler({}, context));
    try {
      await vi.advanceTimersByTimeAsync(0);
      const signal = mocks.s3Send.mock.calls[0][1]?.abortSignal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(observed.state.settled).toBe(true);
      expect(observed.state.value).toEqual({ published: 2, skipped: 0 });
      expect(signal?.aborted).toBe(true);
      assertFallback();
    } finally {
      headers.resolve({ Body: body });
      await observed.completed;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(transform).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });

  it('uses one budget for headers and a pending body, destroying the body on expiry', async () => {
    const headers = deferredSnapshot<{ Body?: { transformToString: () => Promise<string> } }>();
    const text = deferredSnapshot<string>();
    const transform = vi.fn(() => text.promise);
    const body = Object.assign(new Readable({ read() {} }), { transformToString: transform });
    mocks.s3Send.mockReturnValueOnce(headers.promise);
    const observed = observePoll(handler({}, context));
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      headers.resolve({ Body: body });
      await vi.advanceTimersByTimeAsync(0);
      expect(transform).toHaveBeenCalledOnce();
      expect(mocks.priceProviderUsage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(observed.state.settled).toBe(true);
      expect(body.destroyed).toBe(true);
      assertFallback();
      text.reject(new Error('late body failure'));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      headers.resolve({ Body: body });
      text.resolve('{}');
      await observed.completed;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('leaves primary work headroom without admitting an optional read', async () => {
    await expect(handler({}, { ...context, getRemainingTimeInMillis: () => 30_000 })).resolves.toEqual({
      published: 2,
      skipped: 0,
    });
    expect(mocks.s3Send).not.toHaveBeenCalled();
    assertFallback();
  });
});

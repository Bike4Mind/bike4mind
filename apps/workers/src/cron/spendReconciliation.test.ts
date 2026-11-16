import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the external dependencies before importing the handler.
const mockConnectDB = vi.fn();
const mockAppend = vi.fn();
const mockMonthlyCogsByProvider = vi.fn();
const mockCloudWatchSend = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = mockCloudWatchSend;
  },
  PutMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
  spendReconciliationRepository: { append: (...args: unknown[]) => mockAppend(...args) },
  usageEventRepository: { monthlyCogsByProvider: () => mockMonthlyCogsByProvider() },
}));

vi.mock('@bike4mind/observability', () => {
  class MockLogger {
    withMetadata() {
      return this;
    }
    log() {}
    info() {}
    warn() {}
    error() {}
  }
  return { Logger: MockLogger };
});

vi.mock('sst', () => ({ Resource: { App: { name: 'test-app', stage: 'test' } } }));

const mockSecretSend = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = (command: unknown) => mockSecretSend(command);
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://test/%STAGE%',
    ANTHROPIC_ADMIN_API_KEY: 'sk-ant-admin01-test',
    OPENAI_ADMIN_API_KEY: 'sk-openai-test',
  },
}));

const mockAnthropicFetch = vi.fn();
const mockOpenAIFetch = vi.fn();

vi.mock('@bike4mind/services', () => ({
  spendReconciliationService: {
    fetchAnthropicSpend: (...args: unknown[]) => mockAnthropicFetch(...args),
    fetchOpenAISpend: (...args: unknown[]) => mockOpenAIFetch(...args),
  },
}));

// Use a fixed "now" so month selection is deterministic.
const FIXED_NOW = new Date('2026-08-15T06:00:00Z');

describe('spendReconciliation cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: FIXED_NOW });
    mockMonthlyCogsByProvider.mockResolvedValue([
      { month: '2026-07', provider: 'anthropic', cogsUsd: 450, requests: 100 },
      { month: '2026-08', provider: 'anthropic', cogsUsd: 120, requests: 30 },
      { month: '2026-07', provider: 'openai', cogsUsd: 200, requests: 50 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const lambdaContext = {
    awsRequestId: 'req-1',
    functionName: 'spendReconciliation',
    functionVersion: '1',
  } as any;

  async function runHandler() {
    // Dynamic import so mocks are in place.
    const { handler } = await import('./spendReconciliation');
    return handler(undefined, lambdaContext);
  }

  it('reconciles previous and current month', async () => {
    mockAnthropicFetch.mockResolvedValue({ providerUsd: 500, breakdown: { 'key-1': 500 } });
    mockOpenAIFetch.mockResolvedValue({ providerUsd: 210, breakdown: {} });

    await runHandler();

    // Should call each fetcher for 2026-07 and 2026-08.
    expect(mockAnthropicFetch).toHaveBeenCalledTimes(2);
    expect(mockOpenAIFetch).toHaveBeenCalledTimes(2);
    expect(mockAppend).toHaveBeenCalledTimes(4);
  });

  it('computes delta and deltaPct using max(provider, internal) as denominator', async () => {
    mockAnthropicFetch.mockResolvedValue({ providerUsd: 500, breakdown: {} });
    mockOpenAIFetch.mockResolvedValue(null); // skip OpenAI

    await runHandler();

    // 2026-07: provider=$500, internal=$450, delta=+$50, denominator=max(500,450)=500, pct=10%
    const julyCall = mockAppend.mock.calls.find((c: unknown[]) => (c[0] as { month: string }).month === '2026-07');
    expect(julyCall).toBeDefined();
    const julyRow = julyCall![0] as { deltaUsd: number; deltaPct: number; providerUsd: number; internalUsd: number };
    expect(julyRow.providerUsd).toBe(500);
    expect(julyRow.internalUsd).toBe(450);
    expect(julyRow.deltaUsd).toBeCloseTo(50);
    expect(julyRow.deltaPct).toBeCloseTo(10);
  });

  it('does not persist a snapshot when the fetcher throws', async () => {
    mockAnthropicFetch.mockRejectedValue(new Error('Anthropic API 500'));
    mockOpenAIFetch.mockResolvedValue(null);

    const result = await runHandler();
    const body = JSON.parse(result.body);

    expect(body.failed).toBe(2); // both months failed
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('skips providers whose key is not configured', async () => {
    // Override config to have no keys.
    const configMod = await import('@bike4mind/server-utils/utils/config');
    (configMod.Config as Record<string, unknown>).ANTHROPIC_ADMIN_API_KEY = 'not-configured';
    (configMod.Config as Record<string, unknown>).OPENAI_ADMIN_API_KEY = undefined;

    const result = await runHandler();
    const body = JSON.parse(result.body);

    expect(body.skipped).toBeGreaterThan(0);
    expect(mockAnthropicFetch).not.toHaveBeenCalled();
    expect(mockOpenAIFetch).not.toHaveBeenCalled();

    // Restore for other tests.
    (configMod.Config as Record<string, unknown>).ANTHROPIC_ADMIN_API_KEY = 'sk-ant-admin01-test';
    (configMod.Config as Record<string, unknown>).OPENAI_ADMIN_API_KEY = 'sk-openai-test';
  });

  it('uses 0 for internalUsd when no matching COGS row exists', async () => {
    mockAnthropicFetch.mockResolvedValue(null);
    // OpenAI has no 2026-08 COGS row in our mock data.
    mockOpenAIFetch.mockResolvedValue({ providerUsd: 100, breakdown: {} });

    await runHandler();

    const augCall = mockAppend.mock.calls.find((c: unknown[]) => {
      const row = c[0] as { month: string; provider: string };
      return row.month === '2026-08' && row.provider === 'openai';
    });
    expect(augCall).toBeDefined();
    const row = augCall![0] as { internalUsd: number; deltaUsd: number; deltaPct: number };
    expect(row.internalUsd).toBe(0);
    expect(row.deltaUsd).toBe(100);
    expect(row.deltaPct).toBe(100);
  });

  describe('with the admin key secret store', () => {
    const errorLogger = { log: vi.fn(), error: vi.fn() };
    const storedKeys: Record<string, string | Error> = {};

    beforeEach(() => {
      vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC', 'anthropic-secret-arn');
      vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_OPENAI', 'openai-secret-arn');
      storedKeys['anthropic-secret-arn'] = 'stored-anthropic-key';
      storedKeys['openai-secret-arn'] = 'stored-openai-key';
      mockSecretSend.mockImplementation(async command => {
        const value = storedKeys[(command as { input: { SecretId: string } }).input.SecretId];
        if (value instanceof Error) throw value;
        return { SecretString: value };
      });
    });

    it('fetches with the stored keys, not the Config ones', async () => {
      mockAnthropicFetch.mockResolvedValue(null);
      mockOpenAIFetch.mockResolvedValue(null);

      await runHandler();

      expect(mockAnthropicFetch).toHaveBeenCalledWith('stored-anthropic-key', expect.any(String));
      expect(mockOpenAIFetch).toHaveBeenCalledWith('stored-openai-key', expect.any(String));
    });

    it('skips a provider whose secret has no value yet', async () => {
      storedKeys['openai-secret-arn'] = Object.assign(new Error('no current value'), {
        name: 'ResourceNotFoundException',
      });
      mockAnthropicFetch.mockResolvedValue(null);

      const body = JSON.parse((await runHandler()).body);

      expect(body.skipped).toBeGreaterThan(0);
      expect(mockOpenAIFetch).not.toHaveBeenCalled();
    });

    it('counts a failed key lookup as a failed provider and still reconciles the other one', async () => {
      storedKeys['anthropic-secret-arn'] = Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
      });
      mockOpenAIFetch.mockResolvedValue({ providerUsd: 210, breakdown: {} });
      const { runSpendReconciliation } = await import('./spendReconciliation');

      const result = await runSpendReconciliation({ logger: errorLogger as never });

      expect(result).toEqual({ reconciled: 2, skipped: 0, failed: 1, drifted: 0 });
      expect(mockAnthropicFetch).not.toHaveBeenCalled();
      expect(mockOpenAIFetch).toHaveBeenCalledTimes(2);
      expect(errorLogger.error).toHaveBeenCalledWith(
        '[SpendReconciliation] anthropic admin key lookup failed',
        expect.any(Error)
      );
    });

    it('reports every lookup failure when no provider key could be read', async () => {
      const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      storedKeys['anthropic-secret-arn'] = denied;
      storedKeys['openai-secret-arn'] = denied;
      const { runSpendReconciliation } = await import('./spendReconciliation');

      const result = await runSpendReconciliation({ logger: errorLogger as never });

      expect(result).toEqual({ reconciled: 0, skipped: 0, failed: 2, drifted: 0 });
      expect(mockMonthlyCogsByProvider).not.toHaveBeenCalled();
    });
  });

  describe('runSpendReconciliation', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    it('skips every provider without connecting when no admin key is set', async () => {
      const configMod = await import('@bike4mind/server-utils/utils/config');
      const cfg = configMod.Config as Record<string, unknown>;
      cfg.ANTHROPIC_ADMIN_API_KEY = 'not-configured';
      cfg.OPENAI_ADMIN_API_KEY = undefined;
      try {
        const { runSpendReconciliation } = await import('./spendReconciliation');
        const result = await runSpendReconciliation({ logger });

        expect(result).toEqual({ reconciled: 0, skipped: 2, failed: 0, drifted: 0 });
        expect(mockAnthropicFetch).not.toHaveBeenCalled();
        expect(mockOpenAIFetch).not.toHaveBeenCalled();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockConnectDB).not.toHaveBeenCalled();
        expect(mockMonthlyCogsByProvider).not.toHaveBeenCalled();
      } finally {
        cfg.ANTHROPIC_ADMIN_API_KEY = 'sk-ant-admin01-test';
        cfg.OPENAI_ADMIN_API_KEY = 'sk-openai-test';
      }
    });

    it('derives the reconciled months from the injected now', async () => {
      mockAnthropicFetch.mockResolvedValue(null);
      mockOpenAIFetch.mockResolvedValue({ providerUsd: 1, breakdown: {} });
      const { runSpendReconciliation } = await import('./spendReconciliation');

      const result = await runSpendReconciliation({ logger, now: new Date('2027-01-02T06:00:00Z') });

      expect(mockOpenAIFetch.mock.calls.map(c => c[1])).toEqual(['2026-12', '2027-01']);
      // The closed month 2026-12 has no internal COGS row, so $1 billed reads as 100% drift.
      expect(result).toEqual({ reconciled: 2, skipped: 2, failed: 0, drifted: 1 });
      expect(mockAppend).toHaveBeenCalledTimes(2);
      expect(mockConnectDB).not.toHaveBeenCalled();
    });
  });

  describe('drift and nothing-reconciled metrics', () => {
    function publishedMetrics(): Record<string, number> {
      expect(mockCloudWatchSend).toHaveBeenCalledTimes(1);
      const { Namespace, MetricData } = mockCloudWatchSend.mock.calls[0][0].input as {
        Namespace: string;
        MetricData: { MetricName: string; Value: number }[];
      };
      expect(Namespace).toBe('test-app/test/LLMSpend');
      return Object.fromEntries(MetricData.map(datum => [datum.MetricName, datum.Value]));
    }

    it('counts a closed month whose drift exceeds the error band', async () => {
      // 2026-07: provider $600 vs internal $450 -> 25% drift.
      mockAnthropicFetch.mockImplementation(async (_key: string, month: string) =>
        month === '2026-07' ? { providerUsd: 600, breakdown: {} } : { providerUsd: 120, breakdown: {} }
      );
      mockOpenAIFetch.mockResolvedValue(null);

      const body = JSON.parse((await runHandler()).body);

      expect(body.drifted).toBe(1);
      expect(publishedMetrics()).toEqual({ SpendReconciliationDrift: 1, SpendReconciliationNothingReconciled: 0 });
    });

    it('does not count a drift at or under the error band', async () => {
      // 2026-07: provider $500 vs internal $450 -> exactly 10%, the top of the warning band.
      mockAnthropicFetch.mockImplementation(async (_key: string, month: string) =>
        month === '2026-07' ? { providerUsd: 500, breakdown: {} } : { providerUsd: 120, breakdown: {} }
      );
      mockOpenAIFetch.mockResolvedValue(null);

      const body = JSON.parse((await runHandler()).body);

      expect(body).toMatchObject({ reconciled: 2, drifted: 0 });
      expect(publishedMetrics()).toEqual({ SpendReconciliationDrift: 0, SpendReconciliationNothingReconciled: 0 });
    });

    it('leaves the accruing month out of the drift count', async () => {
      // 2026-08: provider $10 vs internal $120 -> 92% drift on a month still accruing.
      mockAnthropicFetch.mockImplementation(async (_key: string, month: string) =>
        month === '2026-07' ? { providerUsd: 450, breakdown: {} } : { providerUsd: 10, breakdown: {} }
      );
      mockOpenAIFetch.mockResolvedValue(null);

      const body = JSON.parse((await runHandler()).body);

      expect(body.drifted).toBe(0);
      expect(publishedMetrics().SpendReconciliationDrift).toBe(0);
    });

    it('flags a run where every provider-month failed or was skipped', async () => {
      mockAnthropicFetch.mockRejectedValue(new Error('Anthropic API 500'));
      mockOpenAIFetch.mockResolvedValue(null);

      const body = JSON.parse((await runHandler()).body);

      expect(body).toMatchObject({ reconciled: 0, failed: 2, skipped: 2 });
      expect(publishedMetrics()).toEqual({ SpendReconciliationDrift: 0, SpendReconciliationNothingReconciled: 1 });
    });

    it('flags a run where no provider admin key is configured', async () => {
      const configMod = await import('@bike4mind/server-utils/utils/config');
      const cfg = configMod.Config as Record<string, unknown>;
      cfg.ANTHROPIC_ADMIN_API_KEY = 'not-configured';
      cfg.OPENAI_ADMIN_API_KEY = undefined;
      try {
        await runHandler();
        expect(publishedMetrics()).toEqual({ SpendReconciliationDrift: 0, SpendReconciliationNothingReconciled: 1 });
      } finally {
        cfg.ANTHROPIC_ADMIN_API_KEY = 'sk-ant-admin01-test';
        cfg.OPENAI_ADMIN_API_KEY = 'sk-openai-test';
      }
    });
  });
});

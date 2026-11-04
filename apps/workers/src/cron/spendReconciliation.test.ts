import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the external dependencies before importing the handler.
const mockConnectDB = vi.fn();
const mockAppend = vi.fn();
const mockMonthlyCogsByProvider = vi.fn();

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

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

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

  describe('runSpendReconciliation', () => {
    const logger = { log: vi.fn(), error: vi.fn() } as never;

    it('skips every provider without connecting when no admin key is set', async () => {
      const configMod = await import('@bike4mind/server-utils/utils/config');
      const cfg = configMod.Config as Record<string, unknown>;
      cfg.ANTHROPIC_ADMIN_API_KEY = 'not-configured';
      cfg.OPENAI_ADMIN_API_KEY = undefined;
      try {
        const { runSpendReconciliation } = await import('./spendReconciliation');
        const result = await runSpendReconciliation({ logger });

        expect(result).toEqual({ reconciled: 0, skipped: 2, failed: 0 });
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
      expect(result).toEqual({ reconciled: 2, skipped: 2, failed: 0 });
      expect(mockAppend).toHaveBeenCalledTimes(2);
      expect(mockConnectDB).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionInfo, IUsageEventRepository } from '@bike4mind/common';

const perM = (usd: number) => usd / 1_000_000;

const LOW_TIER = { tierKey: 200_000, input: perM(2), output: perM(12) };
const HIGH_TIER = { tierKey: 1_048_576, input: perM(4), output: perM(18) };

// Same two-tier Gemini-style ladder as cliCompletions.turnUsage.test.ts.
const literalModel = {
  id: 'tiered-model',
  type: 'text',
  backend: 'gemini',
  contextWindow: 1_048_576,
  max_tokens: 8192,
  pricing: {
    200_000: { input: perM(2), output: perM(12), cache_read: perM(0.2) },
    1_048_576: { input: perM(4), output: perM(18), cache_read: perM(0.4) },
  },
};
const catalogModel = { ...literalModel, priceSource: 'catalog', priceRowId: 'price-row-7' };

const emitted: { info: CompletionInfo; fail?: boolean; model: typeof literalModel } = {
  info: {},
  model: literalModel,
};

// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn(async () => [emitted.model]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model, _messages, _options, onChunk) => {
      await onChunk(['done'], emitted.info);
      if (emitted.fail) throw new Error('client disconnected');
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));

import { executeCompletion, type CompletionParams } from './cliCompletions';

// Only the repository methods used by this completion path need doubles.
function buildDb() {
  const user = { id: 'user1', currentCredits: 1_000_000 };
  return {
    adminSettings: {},
    apiKeys: {},
    creditTransactions: {},
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    },
    usageEvents: { record: vi.fn<IUsageEventRepository['record']>().mockResolvedValue(null) },
  };
}

async function runAndGetEvent(info: CompletionInfo, opts: { fail?: boolean } = {}) {
  emitted.info = info;
  emitted.fail = opts.fail ?? false;
  const db = buildDb();
  const run = executeCompletion({
    userId: 'user1',
    model: 'tiered-model',
    messages: [{ role: 'user', content: 'hi' }],
    // The real repositories have unrelated methods this focused double does not exercise.
    db: db as unknown as CompletionParams['db'],
    onChunk: vi.fn().mockResolvedValue(undefined),
    alwaysRecordUsage: true,
  });
  if (opts.fail) await expect(run).rejects.toThrow('client disconnected');
  else await run;
  expect(db.usageEvents.record).toHaveBeenCalledTimes(1);
  return db.usageEvents.record.mock.calls[0][0];
}

describe('executeCompletion - UsageEvent price stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted.model = literalModel;
    emitted.fail = false;
  });

  it('stamps the literal source and no row id for an adapter-priced model', async () => {
    const event = await runAndGetEvent({ inputTokens: 1000, outputTokens: 100 });
    expect(event.priceSource).toBe('literal');
    expect(event).not.toHaveProperty('priceRowId');
    expect(event.rates).toMatchObject(LOW_TIER);
  });

  it('stamps the catalog source and the row id for a catalog-priced model', async () => {
    emitted.model = catalogModel;
    const event = await runAndGetEvent({ inputTokens: 1000, outputTokens: 100 });
    expect(event.priceSource).toBe('catalog');
    expect(event.priceRowId).toBe('price-row-7');
  });

  it('stamps the tier on each side of the boundary, cache included', async () => {
    const atBoundary = await runAndGetEvent({ inputTokens: 100_000, cacheReadInputTokens: 100_000, outputTokens: 1 });
    expect(atBoundary.rates).toMatchObject(LOW_TIER);
    const past = await runAndGetEvent({ inputTokens: 100_000, cacheReadInputTokens: 100_001, outputTokens: 1 });
    expect(past.rates).toMatchObject(HIGH_TIER);
  });

  it('writes turnUsage for a multi-turn completion, with rates from the largest turn', async () => {
    const event = await runAndGetEvent({
      inputTokens: 281_000,
      outputTokens: 3_000,
      turnUsage: [
        { inputTokens: 80_000, outputTokens: 1_000 },
        { inputTokens: 201_000, outputTokens: 2_000 },
      ],
    });
    expect(event.rates).toMatchObject(HIGH_TIER);
    expect(event.turnUsage).toEqual([
      { inputTokens: 80_000, outputTokens: 1_000, tierKey: 200_000 },
      { inputTokens: 201_000, outputTokens: 2_000, tierKey: 1_048_576 },
    ]);
  });

  it('writes no turnUsage for a single-turn completion', async () => {
    const event = await runAndGetEvent({
      inputTokens: 1000,
      outputTokens: 100,
      turnUsage: [{ inputTokens: 1000, outputTokens: 100 }],
    });
    expect(event).not.toHaveProperty('turnUsage');
    expect(event.rates).toMatchObject(LOW_TIER);
  });

  it('caps turnUsage at 100 entries with a truncation flag on a 101-turn run', async () => {
    const turn = { inputTokens: 10, outputTokens: 1 };
    const event = await runAndGetEvent({
      inputTokens: 1010,
      outputTokens: 101,
      turnUsage: Array.from({ length: 101 }, () => turn),
    });
    expect(event.turnUsage).toHaveLength(100);
    expect(event.turnUsageTruncated).toBe(true);
    expect(event.turnUsage?.at(-1)).toEqual({ inputTokens: 20, outputTokens: 2, tierKey: 200_000 });
  });

  it('stamps the errored-run usage event the same way', async () => {
    emitted.model = catalogModel;
    const event = await runAndGetEvent({ inputTokens: 201_000, outputTokens: 2_000 }, { fail: true });
    expect(event.status).toBe('error');
    expect(event.priceSource).toBe('catalog');
    expect(event.priceRowId).toBe('price-row-7');
    expect(event.rates).toMatchObject(HIGH_TIER);
  });
});

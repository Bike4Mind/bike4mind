import { logLlmUsageSettled } from './llm/llmUsageSettledLog';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionInfo } from '@bike4mind/common';

vi.mock('./llm/llmUsageSettledLog', () => ({ logLlmUsageSettled: vi.fn() }));

const perM = (usd: number) => usd / 1_000_000;

// Synthetic two-tier Gemini-style ladder: the long rate applies above 200K per request.
const tieredModel = {
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

const emitted: { info: CompletionInfo; trailing?: CompletionInfo; fail?: boolean } = { info: {} };

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
  getAvailableModels: vi.fn(async () => [tieredModel]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model, _messages, _options, onChunk) => {
      await onChunk(['done'], emitted.info);
      if (emitted.trailing) await onChunk([], emitted.trailing);
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

import { executeCompletion } from './cliCompletions';

// any: partial repository doubles - only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 1_000_000 };
  return {
    adminSettings: {} as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
  };
}

async function settledUsd(info: CompletionInfo): Promise<number | undefined> {
  emitted.info = info;
  const onChunk = vi.fn().mockResolvedValue(undefined);
  await executeCompletion({
    userId: 'user1',
    model: 'tiered-model',
    messages: [{ role: 'user', content: 'hi' }],
    db: buildDb(),
    onChunk,
  });
  return onChunk.mock.calls.at(-1)?.[1]?.usdCost;
}

describe('executeCompletion - long-context tier per request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted.trailing = undefined;
    emitted.fail = false;
  });

  it('prices a tool loop request by request instead of on the summed prompt', async () => {
    const turn = { inputTokens: 80_000, outputTokens: 1_000 };
    const usd = await settledUsd({ inputTokens: 240_000, outputTokens: 3_000, turnUsage: [turn, turn, turn] });
    expect(usd).toBeCloseTo(0.516, 10);
    expect(logLlmUsageSettled).toHaveBeenCalledTimes(1);
    expect(logLlmUsageSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'gemini',
        model: 'tiered-model',
        inputTokens: 240_000,
        outputTokens: 3_000,
        usd,
        source: 'api',
      })
    );
  });

  it('picks the long tier for a request whose prompt crosses it only with its cache reads', async () => {
    const turns = [{ inputTokens: 20_000, cacheReadInputTokens: 190_000, outputTokens: 1_000 }];
    const usd = await settledUsd({
      inputTokens: 20_000,
      cacheReadInputTokens: 190_000,
      outputTokens: 1_000,
      turnUsage: turns,
    });
    expect(usd).toBeCloseTo(20_000 * perM(4) + 190_000 * perM(0.4) + 1_000 * perM(18), 10);
  });

  it('prices the errored-run usage event request by request too', async () => {
    const turn = { inputTokens: 80_000, outputTokens: 1_000 };
    emitted.info = { inputTokens: 240_000, outputTokens: 3_000, turnUsage: [turn, turn, turn] };
    emitted.fail = true;
    const db = buildDb();
    await expect(
      executeCompletion({
        userId: 'user1',
        model: 'tiered-model',
        messages: [{ role: 'user', content: 'hi' }],
        db,
        onChunk: vi.fn().mockResolvedValue(undefined),
        alwaysRecordUsage: true,
      })
    ).rejects.toThrow('client disconnected');
    emitted.fail = false;
    expect(db.usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', costUsd: expect.closeTo(0.516, 10) })
    );
  });

  it('keeps the latched turns when a later frame carries none', async () => {
    // A toolStarted or artifact frame has no usage; it must not drop settlement back to the aggregates.
    const turn = { inputTokens: 80_000, outputTokens: 1_000 };
    emitted.trailing = { toolStarted: { name: 'search', id: 't1' } };
    const usd = await settledUsd({ inputTokens: 240_000, outputTokens: 3_000, turnUsage: [turn, turn, turn] });
    expect(usd).toBeCloseTo(0.516, 10);
  });

  it('falls back to the aggregates when the adapter reports no turns', async () => {
    const usd = await settledUsd({ inputTokens: 240_000, outputTokens: 3_000 });
    expect(usd).toBeCloseTo(1.014, 10);
  });

  it('prices a cached long prompt in the aggregates on the tier its whole prompt falls in', async () => {
    const usd = await settledUsd({ inputTokens: 20_000, cacheReadInputTokens: 190_000, outputTokens: 1_000 });
    expect(usd).toBeCloseTo(20_000 * perM(4) + 190_000 * perM(0.4) + 1_000 * perM(18), 10);
  });
});

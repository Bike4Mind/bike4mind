import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDITS_PER_USD_COST,
  ModelBackend,
  getTextModelCost,
  reservationOutputTokens,
  usdToCredits,
  type ModelInfo,
} from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';

// Real pricing math: the point of this file is that a round never costs more than the holder has.
const MODEL_ID = 'credit-cap-test-model';
const MAX_TOKENS = 100_000;
const INPUT_TOKENS = 4; // estimateInputTokens over the single short message below

const MODEL_INFO = {
  id: MODEL_ID,
  type: 'text',
  name: 'Credit Cap Test',
  backend: ModelBackend.Anthropic,
  contextWindow: 200_000,
  max_tokens: 128_000,
  pricing: { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
} as unknown as ModelInfo;

const { llm } = vi.hoisted(() => ({
  llm: { complete: vi.fn() } as { complete: ReturnType<typeof vi.fn> },
}));

vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => [MODEL_INFO]),
  getLlmByModel: vi.fn(() => ({ currentModel: '', complete: llm.complete })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));

import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';
import { InsufficientCreditsError } from './llm/ChatCompletionProcess';

const hold = usdToCredits(getTextModelCost(MODEL_INFO, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS)));
const perOutputTokenCredits = (25 / 1_000_000) * CREDITS_PER_USD_COST;
const inputCredits = getTextModelCost(MODEL_INFO, INPUT_TOKENS, 0) * CREDITS_PER_USD_COST;

/** A user whose balance moves with every increment, so the test sees what settlement leaves behind. */
function buildDb(startingBalance: number) {
  let balance = startingBalance;
  const users = {
    incrementCredits: vi.fn(async (_id: string, delta: number) => {
      balance += delta;
      return { id: 'user1', currentCredits: balance };
    }),
    findById: vi.fn(async () => ({ id: 'user1', currentCredits: balance })),
  };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
    },
    users,
    balance: () => balance,
  };
}

const onChunk = vi.fn().mockResolvedValue(undefined);
const baseParams = {
  userId: 'user1',
  model: MODEL_ID,
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk,
  options: { maxTokens: MAX_TOKENS },
};

const sentOptions = (call = 0) => llm.complete.mock.calls[call][2] as Partial<ICompletionOptions>;

describe('executeCompletion - output capped at what the balance can pay for', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llm.complete.mockImplementation(async (_model, _messages, _options, cb) => {
      await cb([''], { inputTokens: INPUT_TOKENS, outputTokens: 50 });
    });
  });

  it('lowers max_tokens when the uncapped worst case exceeds the balance', async () => {
    const startingBalance = 1000;
    // The premise: a full-length answer would overdraw this balance.
    expect(inputCredits + MAX_TOKENS * perOutputTokenCredits).toBeGreaterThan(startingBalance);
    const { db } = buildDb(startingBalance);

    await executeCompletion({ ...baseParams, db });

    const affordable = Math.floor((startingBalance - inputCredits) / perOutputTokenCredits);
    expect(sentOptions().maxTokens).toBe(affordable);
    expect(sentOptions().outputTokenCeiling).toBe(affordable);
    expect(Math.ceil(inputCredits + affordable * perOutputTokenCredits)).toBeLessThanOrEqual(startingBalance);
  });

  it('leaves max_tokens alone for a holder who can pay for the full answer', async () => {
    const { db } = buildDb(1_000_000);

    await executeCompletion({ ...baseParams, db });

    expect(sentOptions().maxTokens).toBe(MAX_TOKENS);
    expect(sentOptions().outputTokenCeiling).toBeGreaterThan(MAX_TOKENS);
  });

  it('refuses an unaffordable round before any model call, and moves nothing', async () => {
    const { db, balance } = buildDb(5);

    await expect(executeCompletion({ ...baseParams, db })).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(balance()).toBe(5);
  });

  it('never settles below zero, charging down to zero when usage outruns the estimate', async () => {
    const startingBalance = hold + 50;
    const { db, balance } = buildDb(startingBalance);
    // A provider reporting far more than the capped budget (the tokenizer estimate missed).
    llm.complete.mockImplementation(async (_model, _messages, _options, cb) => {
      await cb([''], { inputTokens: 200_000, outputTokens: 100_000 });
    });

    await executeCompletion({ ...baseParams, db });

    expect(balance()).toBe(0);
    expect(subtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: startingBalance }),
      expect.anything()
    );
  });
});

describe('executeCompletion - server-side tool loop', () => {
  beforeEach(() => vi.clearAllMocks());

  const serverTools = [
    {
      toolSchema: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } },
      toolFn: vi.fn(async () => 'result'),
    },
  ] as any;

  // Each round answers up to its max_tokens and reports the running total, as adapters do, then
  // recurses through this.complete for the next tool round.
  function loopingComplete(rounds: number) {
    let round = 0;
    const total = { inputTokens: 0, outputTokens: 0 };
    return async function (
      this: ICompletionBackend,
      model: string,
      messages: unknown[],
      options: Partial<ICompletionOptions>,
      cb: (text: string[], info: object) => Promise<void>
    ) {
      round++;
      total.inputTokens += INPUT_TOKENS;
      total.outputTokens += Math.min(LOOP_MAX_TOKENS, options.maxTokens!);
      await cb([''], { ...total });
      if (round < rounds) {
        await this.complete(model, [...(messages as any[]), { role: 'user', content: 'tool result' }], options, cb);
      }
    };
  }
  const LOOP_MAX_TOKENS = 2000;

  it('caps every round and stops cleanly when the balance runs out mid-loop', async () => {
    // A full round costs ~100 credits; the balance covers a few rounds, not ten.
    const startingBalance = Math.ceil(LOOP_MAX_TOKENS * perOutputTokenCredits * 3.85);
    const { db, balance } = buildDb(startingBalance);
    llm.complete.mockImplementation(loopingComplete(10));

    await expect(
      executeCompletion({ ...baseParams, options: { maxTokens: LOOP_MAX_TOKENS }, db, serverTools })
    ).resolves.toBeUndefined();

    const rounds = llm.complete.mock.calls.length;
    expect(rounds).toBeGreaterThan(1);
    expect(rounds).toBeLessThan(10);
    // Every round after the first was capped against what was left at that point.
    for (let i = 1; i < rounds; i++) expect(sentOptions(i).outputTokenCeiling).toBeDefined();
    expect(sentOptions(rounds - 1).outputTokenCeiling!).toBeLessThan(sentOptions(0).outputTokenCeiling!);
    // The truncation reaches the client on the final frame, and the holder is not overdrawn.
    expect(onChunk).toHaveBeenLastCalledWith([], expect.objectContaining({ stopReason: 'max_tokens' }));
    expect(balance()).toBeGreaterThanOrEqual(0);
  });
});

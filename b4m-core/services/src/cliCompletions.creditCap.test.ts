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
import { conservativeRoundInputUsd } from './llm/chatCreditCap';

const hold = usdToCredits(getTextModelCost(MODEL_INFO, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS)));
const perOutputTokenCredits = (25 / 1_000_000) * CREDITS_PER_USD_COST;
// The cap prices input at the dearest rate it can bill: a 5-minute cache write.
const inputCredits = conservativeRoundInputUsd(MODEL_INFO, INPUT_TOKENS, '5m') * CREDITS_PER_USD_COST;

/**
 * A user whose balance moves with every increment, so the test sees what settlement leaves behind.
 * `spendAfterNextRead` lands a concurrent completion's spend right after the next balance read.
 */
function buildDb(startingBalance: number) {
  let balance = startingBalance;
  let pendingSpend = 0;
  const users = {
    incrementCredits: vi.fn(async (_id: string, delta: number) => {
      balance += delta;
      return { id: 'user1', currentCredits: balance };
    }),
    decrementCreditsFloored: vi.fn(async (_id: string, credits: number) => {
      const debited = Math.min(credits, Math.max(balance, 0));
      balance -= debited;
      return debited;
    }),
    findById: vi.fn(async () => {
      const read = { id: 'user1', currentCredits: balance };
      balance -= pendingSpend;
      pendingSpend = 0;
      return read;
    }),
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
    spendAfterNextRead: (credits: number) => {
      pendingSpend = credits;
    },
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

  it('reports the capped ledger charge to onSettled, not the higher computed cost the client was shown', async () => {
    const startingBalance = hold + 50;
    const { db } = buildDb(startingBalance);
    llm.complete.mockImplementation(async (_model, _messages, _options, cb) => {
      await cb([''], { inputTokens: 200_000, outputTokens: 100_000 });
    });
    const onSettled = vi.fn();

    await executeCompletion({ ...baseParams, db, requestId: 'req-capped', onSettled });

    const shown = onChunk.mock.calls.map(([, info]) => info?.creditsUsed).find(used => typeof used === 'number');
    expect(shown).toBeGreaterThan(startingBalance);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-capped', committed: true, creditsCharged: startingBalance })
    );
  });

  it('holds the floor against a concurrent spend landing between the balance read and settlement', async () => {
    const startingBalance = hold + 500;
    const { db, balance, spendAfterNextRead } = buildDb(startingBalance);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    llm.complete.mockImplementation(async (_model, _messages, _options, cb) => {
      await cb([''], { inputTokens: 200_000, outputTokens: 100_000 });
      // The settlement read sees the whole balance, then another completion spends 300 of it.
      spendAfterNextRead(300);
    });

    await executeCompletion({ ...baseParams, db, logger: logger as any });

    expect(balance()).toBe(0);
    // The hold plus the 200 the racing spend left, not the 500 the read promised.
    expect(subtractCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: hold + 200 }), expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('charged down to zero'),
      expect.objectContaining({ charged: hold + 200 })
    );
  });
});

describe('executeCompletion - prompt-cache writes near a low balance', () => {
  // 2.5 chars per estimated token
  const text = (tokens: number) => 'x'.repeat(tokens * 2.5);
  const logger: NonNullable<Parameters<typeof executeCompletion>[0]['logger']> & { error: ReturnType<typeof vi.fn> } = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  const overdrew = () => logger.error.mock.calls.some(([message]) => String(message).includes('charged down to zero'));
  // A balance that pays for the hold and a little more, so the cap (not the hold) is what binds.
  const cappedOutput = reservationOutputTokens(MAX_TOKENS) + 1_000;
  const exactCredits = (writeTokens: number, outputTokens: number) =>
    getTextModelCost(MODEL_INFO, 0, outputTokens, 0, writeTokens) * CREDITS_PER_USD_COST;

  // The provider writes the whole prompt to the cache and answers up to the budget it was sent.
  const writesEverything = (writeTokens: number, outputTokens?: number) =>
    llm.complete.mockImplementation(async (_model, _messages, options: Partial<ICompletionOptions>, cb) => {
      await cb([''], { cacheCreationInputTokens: writeTokens, outputTokens: outputTokens ?? options.maxTokens });
    });

  beforeEach(() => vi.clearAllMocks());

  describe('CLI first round (the server strategy writes the system prompt and history)', () => {
    const messages = [
      { role: 'system' as const, content: text(40_000) },
      { role: 'user' as const, content: text(1_000) },
    ];
    const params = { ...baseParams, source: 'cli' as const, messages, logger };

    it('holds at least what a full cache write plus the held output settles at', async () => {
      const startingBalance = 1_000_000;
      const { db, users, balance } = buildDb(startingBalance);
      writesEverything(41_000, reservationOutputTokens(MAX_TOKENS));

      await executeCompletion({ ...params, db });

      const held = -users.incrementCredits.mock.calls[0][1];
      const charged = startingBalance - balance();
      expect(charged).toBeGreaterThanOrEqual(Math.floor(exactCredits(41_000, reservationOutputTokens(MAX_TOKENS))));
      expect(held).toBeGreaterThanOrEqual(charged);
    });

    it('caps the answer so the cache write and output settle within a near-empty balance', async () => {
      const startingBalance = Math.ceil(exactCredits(41_000, cappedOutput));
      const { db, balance } = buildDb(startingBalance);
      writesEverything(41_000);

      await executeCompletion({ ...params, db });

      expect(sentOptions().maxTokens).toBeLessThan(MAX_TOKENS);
      expect(exactCredits(41_000, sentOptions().maxTokens!)).toBeLessThanOrEqual(startingBalance + 1e-6);
      expect(overdrew()).toBe(false);
      expect(balance()).toBeGreaterThanOrEqual(0);
    });

    it('refuses before any model call when the balance cannot pay for the cache write', async () => {
      // Pays for the plain-rate hold (prompt read plain plus the held output) but not the cache-write hold.
      const startingBalance = Math.floor(exactCredits(41_000, reservationOutputTokens(MAX_TOKENS))) - 1;
      expect(startingBalance).toBeGreaterThan(
        getTextModelCost(MODEL_INFO, 41_000, reservationOutputTokens(MAX_TOKENS)) * CREDITS_PER_USD_COST
      );
      const { db, balance } = buildDb(startingBalance);

      await expect(executeCompletion({ ...params, db })).rejects.toBeInstanceOf(InsufficientCreditsError);

      expect(llm.complete).not.toHaveBeenCalled();
      expect(balance()).toBe(startingBalance);
    });
  });

  describe('later round whose cache has lapsed (held as a read, billed as a write)', () => {
    const messages = [
      { role: 'system' as const, content: text(10_000), cache: true },
      { role: 'user' as const, content: text(20_000) },
      { role: 'assistant' as const, content: text(30_000), cache: true },
      { role: 'user' as const, content: text(8_000) },
    ];
    const params = { ...baseParams, messages, logger };

    it('caps the answer at what the balance pays for once the whole prompt is rewritten', async () => {
      const startingBalance = Math.ceil(exactCredits(68_000, cappedOutput));
      const { db, users, balance } = buildDb(startingBalance);
      writesEverything(68_000);

      await executeCompletion({ ...params, db });

      // The premise: the hold assumed a warm cache, so it is well under the cold-cache cost.
      expect(-users.incrementCredits.mock.calls[0][1]).toBeLessThan(
        exactCredits(68_000, reservationOutputTokens(MAX_TOKENS))
      );
      expect(sentOptions().maxTokens).toBeLessThan(MAX_TOKENS);
      expect(exactCredits(68_000, sentOptions().maxTokens!)).toBeLessThanOrEqual(startingBalance + 1e-6);
      expect(overdrew()).toBe(false);
      expect(balance()).toBeGreaterThanOrEqual(0);
    });

    it('refuses before any model call when the balance is below the hold', async () => {
      const startingBalance = Math.floor(exactCredits(68_000, 0));
      const { db, balance } = buildDb(startingBalance);

      await expect(executeCompletion({ ...params, db })).rejects.toBeInstanceOf(InsufficientCreditsError);

      expect(llm.complete).not.toHaveBeenCalled();
      expect(balance()).toBe(startingBalance);
    });
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

  // Mirrors the adapters' contract: each round answers up to its max_tokens, carries its usage
  // forward in `_internal.accum*` and recurses through this.complete with only a toolsUsed frame.
  // The cumulative total is emitted once, by the terminal round.
  function loopingComplete(rounds: number) {
    let round = 0;
    return async function (
      this: ICompletionBackend,
      model: string,
      messages: unknown[],
      options: Partial<ICompletionOptions>,
      cb: (text: string[], info: object) => Promise<void>
    ) {
      round++;
      const turnUsage = [
        ...(options._internal?.accumTurnUsage ?? []),
        { inputTokens: INPUT_TOKENS, outputTokens: Math.min(LOOP_MAX_TOKENS, options.maxTokens!) },
      ];
      const inputTokens = turnUsage.reduce((sum, turn) => sum + turn.inputTokens, 0);
      const outputTokens = turnUsage.reduce((sum, turn) => sum + turn.outputTokens, 0);
      if (round === rounds) {
        await cb([''], { inputTokens, outputTokens, turnUsage });
        return;
      }
      await cb(['\n\n'], { toolsUsed: [] });
      await this.complete(
        model,
        [...(messages as any[]), { role: 'user', content: 'tool result' }],
        {
          ...options,
          _internal: {
            ...options._internal,
            accumInputTokens: inputTokens,
            accumOutputTokens: outputTokens,
            accumTurnUsage: turnUsage,
          },
        },
        cb
      );
    };
  }
  const LOOP_MAX_TOKENS = 2000;

  /** Credits for the rounds the model actually ran, priced from the options each was sent. */
  const ranRoundsUsd = () =>
    llm.complete.mock.calls.reduce(
      (sum, [, , options]) =>
        sum + getTextModelCost(MODEL_INFO, INPUT_TOKENS, Math.min(LOOP_MAX_TOKENS, options.maxTokens)),
      0
    );

  it('bills every round of a loop that runs to its terminal round', async () => {
    const startingBalance = 1_000_000;
    const { db, balance } = buildDb(startingBalance);
    llm.complete.mockImplementation(loopingComplete(3));

    await executeCompletion({ ...baseParams, options: { maxTokens: LOOP_MAX_TOKENS }, db, serverTools });

    expect(llm.complete).toHaveBeenCalledTimes(3);
    const charged = startingBalance - balance();
    const exactCredits = ranRoundsUsd() * CREDITS_PER_USD_COST;
    expect(charged).toBeGreaterThanOrEqual(Math.floor(exactCredits));
    expect(charged).toBeLessThanOrEqual(Math.ceil(exactCredits));
  });

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
    // No terminal round reported usage, yet every round that ran is billed, not refunded.
    const charged = startingBalance - balance();
    const exactCredits = ranRoundsUsd() * CREDITS_PER_USD_COST;
    expect(charged).toBeGreaterThanOrEqual(Math.floor(exactCredits));
    expect(charged).toBeLessThanOrEqual(Math.ceil(exactCredits));
  });
});

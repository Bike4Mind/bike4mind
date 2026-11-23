import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RUN_BUDGET_EXHAUSTED_ERROR_CODE,
  UnprocessableEntityError,
  type CompletionRunAttribution,
} from '@bike4mind/common';

// A run budget is enforced through the creditHolds adapter: each completion claims what its first round
// can cost and is capped to that claim; a cost past it (an estimate miss) is still charged and committed. The adapter double below claims from one
// shared in-memory run synchronously, the way CompletionRunRepository.claimBudget's compare-and-set does.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
const complete = vi.hoisted(() => vi.fn());
const usesGeminiThinkingOutputCap = vi.hoisted(() => vi.fn(() => false));
// Mirrors geminiBackend: a thinking model is sent its caller cap plus a fixed thinking reserve.
const GEMINI_THINKING_RESERVE = 16_000;
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  usesGeminiThinkingOutputCap,
  geminiThinkingOutputCap: (_model: unknown, callerCap: number) => ({
    maxOutputTokens: callerCap + GEMINI_THINKING_RESERVE,
    callerCapBinds: true,
  }),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn().mockResolvedValue([
    {
      id: 'test-model',
      type: 'text',
      backend: 'anthropic',
      // $1/M input, $10/M output: output dominates, so the claim's output cap is what binds.
      pricing: { 200_000: { input: 1 / 1_000_000, output: 10 / 1_000_000 } },
    },
  ]),
  getLlmByModel: vi.fn(() => ({ currentModel: '', complete })),
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const original = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...original,
    // Deterministic settlement, so totals can be compared exactly.
    usdToCreditsStochastic: vi.fn((usd: number) => original.usdToCredits(usd)),
    getSettingsMap: vi.fn().mockResolvedValue({}),
    getSettingsValue: vi.fn(() => true),
    getSettingsByNames: vi.fn(),
  };
});

import type { ICompletionOptions } from '@bike4mind/llm-adapters';
import { usdToCredits } from '@bike4mind/utils';
import { executeCompletion, type CompletionCreditHolds } from './cliCompletions';

const RUN_ID = '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80';
const MAX_TOKENS = 4000;
const BALANCE = 1_000_000;

const attribution = (role: CompletionRunAttribution['role'], taskId?: string): CompletionRunAttribution => ({
  runId: RUN_ID,
  role,
  ...(taskId && { taskId }),
});

/** One run shared by every completion, plus a per-completion adapter that claims from it. */
function budgetedRun(budgetCredits: number | undefined) {
  const run = { budgetCredits, committedCredits: 0 };
  const claims: number[] = [];
  const topUps: number[] = [];
  const settlements: number[] = [];
  const overruns: number[] = [];
  const holds = (): Required<CompletionCreditHolds> => {
    let claim: number | undefined;
    return {
      async reserve(_hold, debit, runClaim) {
        if (runClaim && run.budgetCredits !== undefined) {
          const credits = Math.min(runClaim.wantedCredits, run.budgetCredits - run.committedCredits);
          if (credits < runClaim.minimumCredits) {
            throw new UnprocessableEntityError('run budget used up', { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE });
          }
          run.committedCredits += credits;
          claim = credits;
          claims.push(credits);
        }
        await debit();
        return claim;
      },
      async refund(refund) {
        await refund();
        if (claim !== undefined) run.committedCredits -= claim;
        return true;
      },
      async settle(_chargedCredits, settle) {
        const recordedCredits = await settle({ runClaimCredits: claim });
        settlements.push(recordedCredits);
        if (claim !== undefined) {
          run.committedCredits += recordedCredits - claim;
          overruns.push(Math.max(0, recordedCredits - claim));
        }
        return true;
      },
      async topUpRunClaim({ wantedCredits, minimumCredits }) {
        if (claim === undefined || run.budgetCredits === undefined) return 0;
        const credits = Math.min(wantedCredits, run.budgetCredits - run.committedCredits);
        if (credits < Math.max(1, minimumCredits)) return 0;
        run.committedCredits += credits;
        claim += credits;
        topUps.push(credits);
        return credits;
      },
    };
  };
  return { run, claims, topUps, settlements, overruns, holds };
}

function buildDb() {
  const user = { id: 'user1', currentCredits: BALANCE };
  const users = {
    findById: vi.fn(async () => ({ ...user })),
    incrementCredits: vi.fn(async (_id: string, delta: number) => {
      user.currentCredits += delta;
      return { ...user };
    }),
    decrementCreditsFloored: vi.fn(async (_id: string, credits: number) => {
      const debited = Math.min(credits, Math.max(0, user.currentCredits));
      user.currentCredits -= debited;
      return debited;
    }),
  };
  const db = {
    adminSettings: {} as never,
    apiKeys: {} as never,
    creditTransactions: {} as never,
    users: users as never,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
    spendFreezes: { findActiveForSubject: vi.fn().mockResolvedValue(null) } as never,
  };
  return { db, users, user };
}

/**
 * A provider that always answers to the full output budget it is handed and reports three times the
 * input the reservation estimated: actual usage above every estimate, the case a run budget must survive.
 */
function overspendingProvider(reportedCredits: number[] = []) {
  complete.mockImplementation(async (_model, messages, options, onChunk) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const outputTokens = options.outputTokenCeiling ?? options.maxTokens ?? MAX_TOKENS;
    const promptChars = JSON.stringify(messages).length;
    const inputTokens = Math.ceil((promptChars / 2.5) * 3);
    reportedCredits.push(usdToCredits(inputTokens * (1 / 1_000_000) + outputTokens * (10 / 1_000_000)));
    await onChunk(['answer'], { inputTokens, outputTokens });
  });
}

const PROMPT = 'Plan the migration and list every risk. '.repeat(40);

describe('executeCompletion - shared run budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overspendingProvider();
  });

  const send = (
    db: ReturnType<typeof buildDb>['db'],
    creditHolds: CompletionCreditHolds,
    run: CompletionRunAttribution,
    logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  ) =>
    executeCompletion({
      userId: 'user1',
      model: 'test-model',
      messages: [{ role: 'user', content: PROMPT }],
      options: { maxTokens: MAX_TOKENS },
      db,
      run,
      creditHolds,
      logger: logger as never,
      source: 'desktop',
      onChunk: vi.fn().mockResolvedValue(undefined),
    });

  /**
   * The documented exposure scenario: a root and four workers start at once against a budget that
   * covers two and a half full answers, and every provider call overruns its estimates. Admission hands
   * out claims that never sum past the budget and each completion is capped to its claim. An estimate miss
   * is charged rather than dropped, so the run can end past its budget by at most each admitted completion's
   * own miss.
   */
  it('admits concurrent root and worker completions only within the budget and charges each overrun to the balance', async () => {
    const probe = budgetedRun(1_000_000);
    await send(buildDb().db, probe.holds(), attribution('root'));
    const budgetCredits = Math.floor(probe.claims[0] * 2.5);
    const wallet = budgetedRun(budgetCredits);
    const { db } = buildDb();
    const reportedCredits: number[] = [];
    overspendingProvider(reportedCredits);

    const results = await Promise.allSettled([
      send(db, wallet.holds(), attribution('root')),
      ...['a', 'b', 'c', 'd'].map(task => send(db, wallet.holds(), attribution('worker', task))),
    ]);

    const admitted = results.filter(result => result.status === 'fulfilled');
    const refused = results.filter(result => result.status === 'rejected');
    expect(admitted.length).toBeGreaterThanOrEqual(2);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const refusal of refused) {
      expect((refusal as PromiseRejectedResult).reason).toMatchObject({
        additionalInfo: { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE },
      });
    }

    const claimed = wallet.claims.reduce((sum, credits) => sum + credits, 0);
    const charged = wallet.settlements.reduce((sum, credits) => sum + credits, 0);
    expect(claimed).toBeLessThanOrEqual(budgetCredits);
    // The most a completion can miss its claim by is what the provider reported beyond it.
    const mostReported = Math.max(...reportedCredits);
    expect(reportedCredits).toHaveLength(admitted.length);
    expect(wallet.settlements.every(credits => credits <= mostReported)).toBe(true);
    for (const overrun of wallet.overruns) {
      expect(overrun).toBeLessThanOrEqual(mostReported - Math.min(...wallet.claims));
    }
    // Every claim was released into exactly what settled: no reservation is left behind.
    expect(wallet.run.committedCredits).toBe(charged);
  });

  it('charges a cost past the claim to the balance and commits it to the run', async () => {
    const wallet = budgetedRun(10_000);
    const { db, user } = buildDb();

    await send(db, wallet.holds(), attribution('root'));

    const [claim] = wallet.claims;
    const [charged] = wallet.settlements;
    expect(charged).toBeGreaterThan(claim);
    expect(BALANCE - user.currentCredits).toBe(charged);
    expect(wallet.run.committedCredits).toBe(charged);
  });

  it('refuses the next completion once an overrun has used up the run budget', async () => {
    const probe = budgetedRun(1_000_000);
    await send(buildDb().db, probe.holds(), attribution('root'));
    const wallet = budgetedRun(probe.claims[0]);
    const { db } = buildDb();

    await send(db, wallet.holds(), attribution('root'));
    expect(wallet.run.committedCredits).toBeGreaterThan(probe.claims[0]);

    await expect(send(db, wallet.holds(), attribution('worker', 'late'))).rejects.toMatchObject({
      additionalInfo: { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('admits a smaller answer from what is left instead of refusing outright', async () => {
    const wallet = budgetedRun(10_000);
    await send(buildDb().db, wallet.holds(), attribution('root'));
    const fullClaim = wallet.claims[0];

    const tight = budgetedRun(Math.floor(fullClaim / 2));
    await send(buildDb().db, tight.holds(), attribution('worker', 'late'));

    expect(tight.claims[0]).toBe(Math.floor(fullClaim / 2));
    expect(complete.mock.calls[1][2].outputTokenCeiling).toBeLessThan(complete.mock.calls[0][2].outputTokenCeiling);
    // The claim was the smaller remaining amount, and releasing it left the run holding the charge.
    expect(tight.claims).toEqual([Math.floor(fullClaim / 2)]);
    expect(tight.run.committedCredits).toBe(tight.settlements[0]);
    expect(tight.settlements[0]).toBeGreaterThan(tight.claims[0]);
  });

  describe('overrun warning', () => {
    const OVERRUN_WARNING = expect.stringContaining('charged past the run budget');
    const warnings = (logger: { warn: ReturnType<typeof vi.fn> }) =>
      logger.warn.mock.calls.filter(([message]) => typeof message === 'string' && message.includes('run budget'));

    it('logs when a committed settle charges past the stored claim', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      await send(buildDb().db, budgetedRun(10_000).holds(), attribution('root'), logger);
      expect(logger.warn).toHaveBeenCalledWith(OVERRUN_WARNING, expect.anything());
    });

    it('does not log when the settle does not commit', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const holds = { ...budgetedRun(10_000).holds(), settle: async () => false };
      await send(buildDb().db, holds, attribution('root'), logger);
      expect(warnings(logger)).toHaveLength(0);
    });

    it('does not log when the stored claim covers the charge but the in-memory claim does not', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const base = budgetedRun(10_000).holds();
      const holds = {
        ...base,
        async settle(_charged: number, settle: Parameters<CompletionCreditHolds['settle']>[1]) {
          await settle({ runClaimCredits: 1_000_000_000 });
          return true;
        },
      };
      await send(buildDb().db, holds, attribution('root'), logger);
      expect(warnings(logger)).toHaveLength(0);
    });
  });

  it('refuses before any debit or provider call when the run cannot cover a short answer', async () => {
    const wallet = budgetedRun(1);
    const { db, users } = buildDb();

    await expect(send(db, wallet.holds(), attribution('worker', 'a'))).rejects.toMatchObject({
      additionalInfo: { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE },
    });
    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(wallet.run.committedCredits).toBe(0);
  });

  it('returns the whole claim to the run when the provider call fails', async () => {
    const wallet = budgetedRun(10_000);
    complete.mockRejectedValueOnce(new Error('provider down'));

    await expect(send(buildDb().db, wallet.holds(), attribution('root'))).rejects.toThrow('provider down');

    expect(wallet.claims).toHaveLength(1);
    expect(wallet.run.committedCredits).toBe(0);
  });

  it('leaves a run without a budget capped by the balance alone', async () => {
    const wallet = budgetedRun(undefined);

    await send(buildDb().db, wallet.holds(), attribution('root'));

    expect(wallet.claims).toHaveLength(0);
    expect(complete.mock.calls[0][2].outputTokenCeiling).toBeGreaterThanOrEqual(MAX_TOKENS);
  });

  it('claims room for a Gemini thinking reserve, so a run with room does not clamp the thinking away', async () => {
    usesGeminiThinkingOutputCap.mockReturnValueOnce(true);
    const wallet = budgetedRun(1_000_000);

    await send(buildDb().db, wallet.holds(), attribution('root'));

    expect(complete.mock.calls[0][2].outputTokenCeiling).toBeGreaterThanOrEqual(MAX_TOKENS + GEMINI_THINKING_RESERVE);
  });
});

describe('executeCompletion - run budget across server-tool rounds', () => {
  const serverTools = [
    {
      toolSchema: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } },
      toolFn: vi.fn(async () => 'result'),
    },
  ] as never;

  // Mirrors the adapters: each round answers to its full output budget, carries usage forward in
  // `_internal.accum*` and recurses through this.complete with the whole conversation plus a tool result.
  function loopingProvider(rounds: number) {
    let round = 0;
    complete.mockImplementation(async function (
      this: { complete: (...args: unknown[]) => Promise<void> },
      model: string,
      messages: Array<{ role: string; content: string }>,
      options: Partial<ICompletionOptions>,
      onChunk: (text: string[], info?: object) => Promise<void>
    ) {
      round++;
      const turnUsage = [
        ...(options._internal?.accumTurnUsage ?? []),
        {
          inputTokens: Math.ceil(JSON.stringify(messages).length / 2.5),
          outputTokens: options.outputTokenCeiling ?? options.maxTokens ?? MAX_TOKENS,
        },
      ];
      const inputTokens = turnUsage.reduce((sum, turn) => sum + turn.inputTokens, 0);
      const outputTokens = turnUsage.reduce((sum, turn) => sum + turn.outputTokens, 0);
      if (round === rounds) {
        await onChunk(['answer'], { inputTokens, outputTokens, turnUsage });
        return;
      }
      await onChunk(['\n\n'], { toolsUsed: [] });
      await this.complete(
        model,
        [...messages, { role: 'user', content: 'tool result' }],
        {
          ...options,
          _internal: {
            ...options._internal,
            accumInputTokens: inputTokens,
            accumOutputTokens: outputTokens,
            accumTurnUsage: turnUsage,
          },
        },
        onChunk
      );
    });
  }

  beforeEach(() => vi.clearAllMocks());

  const send = (creditHolds: CompletionCreditHolds, onChunk = vi.fn().mockResolvedValue(undefined)) =>
    executeCompletion({
      userId: 'user1',
      model: 'test-model',
      messages: [{ role: 'user', content: PROMPT }],
      options: { maxTokens: MAX_TOKENS },
      db: buildDb().db,
      run: attribution('root'),
      creditHolds,
      serverTools,
      source: 'desktop',
      onChunk,
    });

  it('tops the claim up so a later tool round runs, and still settles inside what was claimed', async () => {
    const wallet = budgetedRun(1_000_000);
    loopingProvider(2);

    await send(wallet.holds());

    expect(complete).toHaveBeenCalledTimes(2);
    expect(wallet.topUps).toHaveLength(1);
    const claimed = wallet.claims[0] + wallet.topUps[0];
    expect(wallet.settlements[0]).toBeLessThanOrEqual(claimed);
    expect(wallet.run.committedCredits).toBe(wallet.settlements[0]);
  });

  it('ends the loop with max_tokens when the run has nothing left to top up with', async () => {
    const probe = budgetedRun(1_000_000);
    loopingProvider(1);
    await send(probe.holds());
    const wallet = budgetedRun(probe.claims[0]);
    complete.mockClear();
    loopingProvider(3);
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await send(wallet.holds(), onChunk);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(wallet.topUps).toHaveLength(0);
    expect(onChunk).toHaveBeenLastCalledWith([], expect.objectContaining({ stopReason: 'max_tokens' }));
    expect(wallet.settlements[0]).toBeLessThanOrEqual(wallet.claims[0]);
  });
});

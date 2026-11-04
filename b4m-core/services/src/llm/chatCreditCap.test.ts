import { describe, expect, it } from 'vitest';
import { CREDITS_PER_USD_COST, ModelBackend, estimateStreamedOutputTokens, type ModelInfo } from '@bike4mind/common';
import { MIN_AFFORDABLE_OUTPUT_TOKENS } from '../completionCreditBudget';
import {
  TurnCreditLimiter,
  accumulatedRoundsUsd,
  adoptAccumulatedUsage,
  cappedSettlementDelta,
  completionOverdraftAllowance,
  conservativeRoundInputUsd,
  estimateAddedInputTokens,
  type SettledUsage,
} from './chatCreditCap';

// $5/M input, $25/M output: a premium-model price point.
const MODEL = {
  id: 'cap-test-model',
  backend: ModelBackend.Anthropic,
  pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
} as unknown as ModelInfo;

const perOutputTokenCredits = (25 / 1_000_000) * CREDITS_PER_USD_COST;
const inputCredits = (usd: number) => usd * CREDITS_PER_USD_COST;

/** Worst-case credits of a round: its input at the dearest rate plus a full-length answer. */
const worstCaseCredits = (inputUsd: number, outputTokens: number) =>
  inputCredits(inputUsd) + outputTokens * perOutputTokenCredits;

describe('completionOverdraftAllowance', () => {
  it('gives an account without a paid plan no allowance', () => {
    expect(completionOverdraftAllowance({ billedToOrganization: false, hasPaidPlan: false, allowanceCredits: 500 })).toBe(
      0
    );
  });

  it('gives a paid personal account the configured allowance', () => {
    expect(completionOverdraftAllowance({ billedToOrganization: false, hasPaidPlan: true, allowanceCredits: 500 })).toBe(
      500
    );
  });

  it('keeps an organization at its balance', () => {
    expect(completionOverdraftAllowance({ billedToOrganization: true, hasPaidPlan: true, allowanceCredits: 500 })).toBe(
      0
    );
  });

  it.each([Number.NaN, -10, Number.POSITIVE_INFINITY])('reads a malformed setting (%s) as no allowance', value => {
    expect(completionOverdraftAllowance({ billedToOrganization: false, hasPaidPlan: true, allowanceCredits: value })).toBe(
      0
    );
  });
});

describe('conservativeRoundInputUsd', () => {
  it('prices input at the cache-write rate, the dearest a 5-minute cache can bill', () => {
    const usd = conservativeRoundInputUsd(MODEL, 10_000, '5m');
    expect(usd).toBeCloseTo(10_000 * (5 / 1_000_000) * 1.25, 10);
  });

  it('prices a 1-hour session at the 1-hour write rate', () => {
    expect(conservativeRoundInputUsd(MODEL, 10_000, '1h')).toBeGreaterThan(conservativeRoundInputUsd(MODEL, 10_000, '5m'));
  });

  it('is zero for no input', () => {
    expect(conservativeRoundInputUsd(MODEL, 0, '5m')).toBe(0);
  });
});

describe('TurnCreditLimiter.beginRound', () => {
  const inputUsd = conservativeRoundInputUsd(MODEL, 10_000, '5m');

  it('caps output so input plus a full-length answer fits the limit, and one more token would not', () => {
    const limiter = new TurnCreditLimiter(1_427, 0);
    const budget = limiter.beginRound({ modelInfo: MODEL, inputTokens: 10_000, inputUsd, spentUsd: 0, maxOutputTokens: 128_000 });

    if (!budget.affordable) throw new Error('expected an affordable round');
    expect(worstCaseCredits(inputUsd, budget.outputTokens)).toBeLessThanOrEqual(1_427);
    expect(worstCaseCredits(inputUsd, budget.outputTokens + 1)).toBeGreaterThan(1_427);
    expect(limiter.stoppedForCredits).toBe(false);
  });

  it('affords exactly the remaining output at the boundary', () => {
    const outputTokens = 2_000;
    const limit = worstCaseCredits(inputUsd, outputTokens);
    const budget = new TurnCreditLimiter(limit, 0).beginRound({
      modelInfo: MODEL,
      inputTokens: 10_000,
      inputUsd,
      spentUsd: 0,
      maxOutputTokens: 128_000,
    });
    expect(budget).toEqual({ affordable: true, outputTokens });
  });

  it('refuses when the limit cannot buy the minimum answer', () => {
    const limit = worstCaseCredits(inputUsd, MIN_AFFORDABLE_OUTPUT_TOKENS) - 1;
    const limiter = new TurnCreditLimiter(limit, 0);
    const budget = limiter.beginRound({ modelInfo: MODEL, inputTokens: 10_000, inputUsd, spentUsd: 0, maxOutputTokens: 128_000 });

    expect(budget.affordable).toBe(false);
    if (budget.affordable) return;
    expect(budget.minimumCredits).toBe(Math.ceil(worstCaseCredits(inputUsd, MIN_AFFORDABLE_OUTPUT_TOKENS)));
    expect(limiter.stoppedForCredits).toBe(true);
  });

  it('asks for no more than the round ceiling as its minimum', () => {
    const limit = worstCaseCredits(inputUsd, 64);
    const budget = new TurnCreditLimiter(limit, 0).beginRound({
      modelInfo: MODEL,
      inputTokens: 10_000,
      inputUsd,
      spentUsd: 0,
      maxOutputTokens: 64,
    });
    expect(budget.affordable).toBe(true);
  });

  it('takes what earlier rounds spent off a later round', () => {
    const limiter = new TurnCreditLimiter(1_000, 0);
    const first = limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd: 0, maxOutputTokens: 1e6 });
    const spentUsd = 600 / CREDITS_PER_USD_COST;
    const later = limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd, maxOutputTokens: 1e6 });
    if (!first.affordable || !later.affordable) throw new Error('expected both rounds to be affordable');
    expect(later.outputTokens).toBe(Math.floor(400 / perOutputTokenCredits + 1e-9));
    expect(later.outputTokens).toBeLessThan(first.outputTokens);
  });

  it('lets a paid account answer longer by exactly its allowance', () => {
    const free = new TurnCreditLimiter(1_000, 0).beginRound({
      modelInfo: MODEL,
      inputTokens: 1_000,
      inputUsd: 0,
      spentUsd: 0,
      maxOutputTokens: 1e6,
    });
    const paid = new TurnCreditLimiter(1_500, 500).beginRound({
      modelInfo: MODEL,
      inputTokens: 1_000,
      inputUsd: 0,
      spentUsd: 0,
      maxOutputTokens: 1e6,
    });
    if (!free.affordable || !paid.affordable) throw new Error('expected both rounds to be affordable');
    expect(paid.outputTokens - free.outputTokens).toBeCloseTo(500 / perOutputTokenCredits, -1);
  });
});

describe('TurnCreditLimiter.recordStreamed', () => {
  it('stops a stream once its streamed output alone runs the turn past the limit', () => {
    const limiter = new TurnCreditLimiter(100, 0);
    limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd: 0, maxOutputTokens: 1e6 });

    let streamed = 0;
    let stopped = false;
    while (!stopped) {
      streamed += 60;
      stopped = limiter.recordStreamed(60);
    }

    const outputCredits = estimateStreamedOutputTokens(streamed, MODEL.id) * perOutputTokenCredits;
    const previousCredits = estimateStreamedOutputTokens(streamed - 60, MODEL.id) * perOutputTokenCredits;
    expect(outputCredits).toBeGreaterThan(100);
    expect(previousCredits).toBeLessThanOrEqual(100);
    expect(limiter.stoppedForCredits).toBe(true);
    // Sticky: later chunks of the same turn keep reporting the stop.
    expect(limiter.recordStreamed(1)).toBe(true);
  });

  it('never stops a stream that stays within what the round was budgeted', () => {
    const limiter = new TurnCreditLimiter(1_000, 0);
    const budget = limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd: 0, maxOutputTokens: 1e6 });
    if (!budget.affordable) throw new Error('expected an affordable round');
    // The stream estimate is a lower bound on tokens: even one character per budgeted token reads
    // as well under the budget, so the per-round cap, not this, is what ends a normal answer.
    expect(limiter.recordStreamed(budget.outputTokens)).toBe(false);
  });

  it('counts each round from its own start', () => {
    const limiter = new TurnCreditLimiter(100, 0);
    limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd: 0, maxOutputTokens: 1e6 });
    limiter.recordStreamed(10_000);
    limiter.beginRound({ modelInfo: MODEL, inputTokens: 1_000, inputUsd: 0, spentUsd: 0, maxOutputTokens: 1e6 });
    expect(limiter.recordStreamed(100)).toBe(false);
  });
});

describe('cappedSettlementDelta', () => {
  it('refunds the unused hold exactly', () => {
    expect(cappedSettlementDelta(1_400, 900, 27, 0)).toEqual({ delta: 500, writtenOffCredits: 0 });
  });

  it('charges a shortfall the balance covers in full, so settlement equals usage', () => {
    expect(cappedSettlementDelta(1_400, 1_420, 27, 0)).toEqual({ delta: -20, writtenOffCredits: 0 });
  });

  it('floors an account without a paid plan at zero and writes off the rest', () => {
    const balanceAfterHold = 27;
    const { delta, writtenOffCredits } = cappedSettlementDelta(1_400, 4_600, balanceAfterHold, 0);
    expect(balanceAfterHold + delta).toBe(0);
    expect(-delta + writtenOffCredits).toBe(4_600 - 1_400);
  });

  it('lets a paid account go no lower than minus its allowance', () => {
    const balanceAfterHold = 27;
    const { delta, writtenOffCredits } = cappedSettlementDelta(1_400, 4_600, balanceAfterHold, -500);
    expect(balanceAfterHold + delta).toBe(-500);
    expect(writtenOffCredits).toBe(4_600 - 1_400 - 527);
  });

  it('collects nothing more from a balance already at the floor', () => {
    expect(cappedSettlementDelta(100, 300, -10, 0)).toEqual({ delta: 0, writtenOffCredits: 200 });
  });
});

describe('the cap end to end', () => {
  it('leaves a balance no lower than minus the allowance when the stream is stopped mid-answer', () => {
    for (const allowance of [0, 500]) {
      const balanceBefore = 1_427;
      const hold = 1_400;
      const balanceAfterHold = balanceBefore - hold;
      const limiter = new TurnCreditLimiter(balanceAfterHold + hold + allowance, allowance);
      const inputUsd = conservativeRoundInputUsd(MODEL, 5_000, '5m');
      limiter.beginRound({ modelInfo: MODEL, inputTokens: 5_000, inputUsd, spentUsd: 0, maxOutputTokens: 1e6 });

      let streamed = 0;
      while (!limiter.recordStreamed(600)) streamed += 600;
      streamed += 600;

      // Settle on a provider count denser than the stream estimate (tokens drift from chars), the
      // case where a charge would otherwise run past the limit.
      const actualOutputTokens = Math.ceil(streamed / 3);
      const used = Math.ceil(inputCredits(inputUsd) + actualOutputTokens * perOutputTokenCredits);
      const { delta } = cappedSettlementDelta(hold, used, balanceAfterHold, limiter.settlementFloorCredits());
      expect(balanceAfterHold + delta).toBeGreaterThanOrEqual(-allowance);
      // Never more than was used.
      expect(hold - delta).toBeLessThanOrEqual(used);
    }
  });
});

describe('accumulatedRoundsUsd', () => {
  it('prices the per-turn breakdown when the adapter carries one', () => {
    const usd = accumulatedRoundsUsd(MODEL, {
      accumTurnUsage: [
        { inputTokens: 1_000, outputTokens: 100 },
        { inputTokens: 2_000, outputTokens: 200 },
      ],
    });
    expect(usd).toBeCloseTo((3_000 * 5 + 300 * 25) / 1_000_000, 10);
  });

  it('prices the aggregates otherwise, and nothing without usage', () => {
    expect(accumulatedRoundsUsd(MODEL, { accumInputTokens: 1_000, accumOutputTokens: 100 })).toBeCloseTo(
      (1_000 * 5 + 100 * 25) / 1_000_000,
      10
    );
    expect(accumulatedRoundsUsd(MODEL, undefined)).toBe(0);
  });
});

describe('adoptAccumulatedUsage', () => {
  it('takes the earlier rounds a stopped loop never reported', () => {
    const usage: SettledUsage = { inputTokens: 1_000, outputTokens: 50 };
    adoptAccumulatedUsage(usage, { accumInputTokens: 3_000, accumOutputTokens: 400, accumCacheReadTokens: 10 }, '5m');
    expect(usage).toMatchObject({ inputTokens: 3_000, outputTokens: 400, cacheReadInputTokens: 10 });
  });

  it('never lowers a count already reported', () => {
    const usage: SettledUsage = { inputTokens: 5_000, outputTokens: 900 };
    adoptAccumulatedUsage(usage, { accumInputTokens: 3_000, accumOutputTokens: 400 }, '5m');
    expect(usage).toMatchObject({ inputTokens: 5_000, outputTokens: 900 });
  });

  it('replaces a shorter per-turn breakdown with the longer one', () => {
    const usage: SettledUsage = { turnUsage: [{ inputTokens: 1_000, outputTokens: 10 }] };
    adoptAccumulatedUsage(
      usage,
      {
        accumTurnUsage: [
          { inputTokens: 1_000, outputTokens: 10 },
          { inputTokens: 1_500, outputTokens: 20, cacheReadInputTokens: 900 },
        ],
      },
      '5m'
    );
    expect(usage).toMatchObject({ inputTokens: 2_500, outputTokens: 30, cacheReadInputTokens: 900 });
    expect(usage.turnUsage).toHaveLength(2);
  });
});

describe('estimateAddedInputTokens', () => {
  it('counts string and structured content at 2.5 chars per token', () => {
    expect(estimateAddedInputTokens([{ role: 'user', content: 'x'.repeat(25) }])).toBe(10);
    expect(estimateAddedInputTokens([])).toBe(0);
  });
});

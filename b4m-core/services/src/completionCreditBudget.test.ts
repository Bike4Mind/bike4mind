import { describe, expect, it, vi } from 'vitest';
import { CREDITS_PER_USD_COST, ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import {
  MIN_AFFORDABLE_OUTPUT_TOKENS,
  affordableRoundBudget,
  capRoundOutput,
  gateEveryRound,
} from './completionCreditBudget';

// $1/M input, $10/M output on one tier; a second, dearer tier above 1000 input tokens.
const MODEL_INFO = {
  id: 'budget-test-model',
  backend: ModelBackend.Anthropic,
  pricing: {
    1000: { input: 1 / 1_000_000, output: 10 / 1_000_000 },
    200_000: { input: 2 / 1_000_000, output: 20 / 1_000_000 },
  },
} as unknown as ModelInfo;

const perOutputTokenCredits = (10 / 1_000_000) * CREDITS_PER_USD_COST;

describe('affordableRoundBudget', () => {
  it('returns the largest output budget whose worst case fits the available credits', () => {
    const inputUsd = 0.001;
    const budget = affordableRoundBudget({
      modelInfo: MODEL_INFO,
      inputUsd,
      inputTokens: 500,
      availableCredits: 100,
      minimumOutputTokens: MIN_AFFORDABLE_OUTPUT_TOKENS,
    });

    const expected = Math.floor((100 - inputUsd * CREDITS_PER_USD_COST) / perOutputTokenCredits);
    expect(budget).toEqual({ affordable: true, outputTokens: expected });
    // Input plus a full-length answer stays within the balance.
    expect(Math.ceil(inputUsd * CREDITS_PER_USD_COST + expected * perOutputTokenCredits)).toBeLessThanOrEqual(100);
  });

  it('prices output at the tier the input lands on', () => {
    const cheap = affordableRoundBudget({
      modelInfo: MODEL_INFO,
      inputUsd: 0,
      inputTokens: 500,
      availableCredits: 100,
      minimumOutputTokens: 1,
    });
    const dear = affordableRoundBudget({
      modelInfo: MODEL_INFO,
      inputUsd: 0,
      inputTokens: 5000,
      availableCredits: 100,
      minimumOutputTokens: 1,
    });
    if (!cheap.affordable || !dear.affordable) throw new Error('expected both rounds to be affordable');
    expect(cheap.outputTokens).toBe(dear.outputTokens * 2);
  });

  it('is unaffordable when even the minimum answer does not fit', () => {
    const budget = affordableRoundBudget({
      modelInfo: MODEL_INFO,
      inputUsd: 0.04,
      inputTokens: 500,
      availableCredits: 0.04 * CREDITS_PER_USD_COST + 10 * perOutputTokenCredits,
      minimumOutputTokens: 256,
    });
    expect(budget).toEqual({
      affordable: false,
      minimumCredits: Math.ceil(0.04 * CREDITS_PER_USD_COST + 256 * perOutputTokenCredits),
    });
  });

  it('is unaffordable with nothing left, however small the minimum', () => {
    expect(
      affordableRoundBudget({
        modelInfo: MODEL_INFO,
        inputUsd: 0,
        inputTokens: 10,
        availableCredits: -5,
        minimumOutputTokens: 1,
      }).affordable
    ).toBe(false);
  });
});

describe('capRoundOutput', () => {
  it('lowers maxTokens and sets the ceiling to the affordable figure', () => {
    expect(capRoundOutput({ maxTokens: 64_000, temperature: 0 }, 5000)).toEqual({
      maxTokens: 5000,
      outputTokenCeiling: 5000,
      temperature: 0,
    });
  });

  it('keeps a smaller maxTokens but still bounds what an adapter may raise it to', () => {
    expect(capRoundOutput({ maxTokens: 4096 }, 20_000)).toEqual({ maxTokens: 4096, outputTokenCeiling: 20_000 });
  });
});

describe('gateEveryRound', () => {
  type Complete = ICompletionBackend['complete'];

  // Recurses the way every adapter's tool loop does: through `this.complete`.
  class LoopingBackend {
    currentModel = 'm';
    sent: Partial<ICompletionOptions>[] = [];
    constructor(private readonly rounds: number) {}
    complete: Complete = async function (this: LoopingBackend, model, messages, options, callback) {
      this.sent.push(options);
      await callback(['round'], { outputTokens: this.sent.length });
      if (this.sent.length < this.rounds) {
        await this.complete(model, [...messages, { role: 'user', content: 'tool result' }], options, callback);
      }
    };
  }
  const asBackend = (b: LoopingBackend) => b as unknown as ICompletionBackend;

  it('runs the gate before every round, including the tool-loop recursion', async () => {
    const backend = new LoopingBackend(3);
    const seen: Array<{ round: number; messages: number }> = [];
    const gated = gateEveryRound(asBackend(backend), async (messages: IMessage[], options, round) => {
      seen.push({ round, messages: messages.length });
      return { ...options, maxTokens: 100 - round };
    });

    await gated.complete('m', [{ role: 'user', content: 'hi' }], { maxTokens: 1000 }, vi.fn());

    expect(seen).toEqual([
      { round: 0, messages: 1 },
      { round: 1, messages: 2 },
      { round: 2, messages: 3 },
    ]);
    expect(backend.sent.map(o => o.maxTokens)).toEqual([100, 99, 98]);
  });

  it('ends the turn without calling the model when the gate returns null', async () => {
    const backend = new LoopingBackend(5);
    const callback = vi.fn();
    const gated = gateEveryRound(asBackend(backend), async (_messages, options, round) =>
      round >= 2 ? null : options
    );

    await expect(gated.complete('m', [], {}, callback)).resolves.toBeUndefined();

    expect(backend.sent).toHaveLength(2);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

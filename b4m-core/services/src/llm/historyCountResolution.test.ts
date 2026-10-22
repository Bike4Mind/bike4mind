import { describe, it, expect } from 'vitest';
import {
  ChatCompletionInvokeParamsSchema,
  isUnlimitedHistory,
  normalizeRequestedHistoryCount,
  UNLIMITED_HISTORY_COUNT,
} from '@bike4mind/common';
import { resolveModelAwareHistoryCount } from './ChatCompletionProcess';

/**
 * The old sentinel for "no history window" was 14, which is inside the range
 * resolveModelAwareHistoryCount clamps into, so the two meanings collided in both directions:
 * a computed 14 was read as unlimited, and a requested unlimited was clamped into a plain count.
 */
describe('resolveModelAwareHistoryCount', () => {
  // Windows whose model-aware max is exactly the old sentinel, 14.
  const COLLIDING_CONTEXT_WINDOWS = [75_000, 76_000];

  describe('a computed count that lands on the old sentinel', () => {
    it.each(COLLIDING_CONTEXT_WINDOWS)('stays an ordinary count on a %i-token model', contextWindow => {
      const resolved = resolveModelAwareHistoryCount({ historyCount: 30, contextWindow });

      expect(resolved).toBe(14);
      expect(isUnlimitedHistory(resolved)).toBe(false);
    });
  });

  describe('unlimited history', () => {
    it.each([
      ['a model whose max is exactly the old sentinel', 76_000],
      ['a small model whose max is below the old sentinel', 8_192],
      ['a mid-size model', 32_000],
    ])('survives %s', (_label, contextWindow) => {
      const resolved = resolveModelAwareHistoryCount({
        historyCount: UNLIMITED_HISTORY_COUNT,
        contextWindow,
      });

      expect(resolved).toBe(UNLIMITED_HISTORY_COUNT);
      expect(isUnlimitedHistory(resolved)).toBe(true);
    });
  });

  it('still narrows a count the model cannot afford', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 60, contextWindow: 8_192 })).toBe(10);
  });

  it('leaves a count the model can afford alone', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 5, contextWindow: 200_000 })).toBe(5);
  });

  it('does not resurrect history for an image model, which requests none', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 0, contextWindow: 10_000 })).toBe(0);
  });
});

describe('normalizeRequestedHistoryCount', () => {
  it('translates the client slider sentinel into the internal marker', () => {
    expect(normalizeRequestedHistoryCount(14)).toBe(UNLIMITED_HISTORY_COUNT);
  });

  it('leaves every other requested count untouched', () => {
    for (const requested of [0, 1, 5, 10, 12, 13, 15, 30, 60]) {
      expect(normalizeRequestedHistoryCount(requested)).toBe(requested);
    }
  });
});

/**
 * The invoke schema carries wire values, which are translated into the internal marker later,
 * in ChatCompletionProcess. Nothing outside should be able to hand the marker straight in.
 */
describe('ChatCompletionInvokeParamsSchema.historyCount', () => {
  const historyCount = ChatCompletionInvokeParamsSchema.shape.historyCount;

  it('refuses the internal unlimited marker', () => {
    expect(historyCount.safeParse(UNLIMITED_HISTORY_COUNT).success).toBe(false);
  });

  it('refuses any other negative count', () => {
    expect(historyCount.safeParse(-5).success).toBe(false);
  });

  it('accepts zero, which is how an image model asks for no history', () => {
    expect(historyCount.safeParse(0).success).toBe(true);
  });

  it('accepts the client slider sentinel and ordinary counts', () => {
    for (const wire of [1, 10, 14, 30, 150]) {
      expect(historyCount.safeParse(wire).success).toBe(true);
    }
  });
});

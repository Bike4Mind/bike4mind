import { describe, it, expect } from 'vitest';
import { isUnlimitedHistory, normalizeRequestedHistoryCount, UNLIMITED_HISTORY_COUNT } from '@bike4mind/common';
import { resolveModelAwareHistoryCount } from './ChatCompletionProcess';

/**
 * The old sentinel for "no history window" was 14, which is inside the range
 * resolveModelAwareHistoryCount clamps into, so the two meanings collided in both directions:
 * a computed 14 was read as unlimited, and a requested unlimited was clamped into a plain count.
 */
describe('resolveModelAwareHistoryCount', () => {
  // Both windows are in the model registry, and both make a simple query land on exactly 14.
  const COLLIDING_CONTEXT_WINDOWS = [128_000, 131_072];

  describe('a computed count that lands on the old sentinel', () => {
    it.each(COLLIDING_CONTEXT_WINDOWS)('stays an ordinary count on a %ik model', contextWindow => {
      const resolved = resolveModelAwareHistoryCount({ historyCount: 30, contextWindow, isSimpleQuery: true });

      expect(resolved).toBe(14);
      expect(isUnlimitedHistory(resolved)).toBe(false);
    });
  });

  describe('unlimited history', () => {
    it.each([
      ['a 128k model where the simple-query max is exactly the old sentinel', 128_000, true],
      ['a small model whose max is below the old sentinel', 8_192, true],
      ['a small model on the complex path', 32_000, false],
    ])('survives %s', (_label, contextWindow, isSimpleQuery) => {
      const resolved = resolveModelAwareHistoryCount({
        historyCount: UNLIMITED_HISTORY_COUNT,
        contextWindow,
        isSimpleQuery,
      });

      expect(resolved).toBe(UNLIMITED_HISTORY_COUNT);
      expect(isUnlimitedHistory(resolved)).toBe(true);
    });
  });

  it('still narrows a count the model cannot afford', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 60, contextWindow: 8_192, isSimpleQuery: false })).toBe(10);
  });

  it('leaves a count the model can afford alone', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 5, contextWindow: 200_000, isSimpleQuery: false })).toBe(5);
  });

  it('does not resurrect history for an image model, which requests none', () => {
    expect(resolveModelAwareHistoryCount({ historyCount: 0, contextWindow: 10_000, isSimpleQuery: true })).toBe(0);
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

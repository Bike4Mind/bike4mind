import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithDeadline } from './waitTurnDeadline';

const LIMITS = { budgetMs: 1_000, windDownMs: 500 };

/** A turn that ends only when its signal aborts, the way ChatCompletionProcess winds down. */
const endsOnAbort =
  (settle: 'resolve' | 'reject') =>
  (abortSignal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      abortSignal.addEventListener('abort', () =>
        settle === 'resolve' ? resolve() : reject(new Error('This operation was aborted'))
      );
    });

describe('runWithDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports completed for a turn that finishes inside the budget, and never aborts it', async () => {
    let seenSignal: AbortSignal | undefined;
    const result = runWithDeadline(async abortSignal => {
      seenSignal = abortSignal;
    }, LIMITS);
    await expect(result).resolves.toEqual({ outcome: 'completed' });
    await vi.advanceTimersByTimeAsync(LIMITS.budgetMs * 2);
    expect(seenSignal?.aborted).toBe(false);
  });

  it('rethrows an error the turn raised before the deadline', async () => {
    const failure = new Error('provider exploded');
    await expect(runWithDeadline(() => Promise.reject(failure), LIMITS)).rejects.toBe(failure);
  });

  it('reports aborted when the turn winds down after the deadline fires', async () => {
    const result = runWithDeadline(endsOnAbort('resolve'), LIMITS);
    await vi.advanceTimersByTimeAsync(LIMITS.budgetMs);
    await expect(result).resolves.toEqual({ outcome: 'aborted' });
  });

  it('reports aborted with the error when the abort makes the turn throw', async () => {
    const result = runWithDeadline(endsOnAbort('reject'), LIMITS);
    await vi.advanceTimersByTimeAsync(LIMITS.budgetMs);
    await expect(result).resolves.toEqual({ outcome: 'aborted', error: expect.any(Error) });
  });

  it('reports stuck when the turn ignores the abort past the wind-down', async () => {
    const result = runWithDeadline(() => new Promise<never>(() => {}), LIMITS);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(LIMITS.budgetMs + LIMITS.windDownMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ outcome: 'stuck' });
  });

  it('aborts at once when the budget is already spent', async () => {
    const result = runWithDeadline(endsOnAbort('resolve'), { budgetMs: -5, windDownMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ outcome: 'aborted' });
  });
});

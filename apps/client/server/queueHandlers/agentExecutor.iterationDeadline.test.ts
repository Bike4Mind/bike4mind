import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runIterationWithDeadlineGuard } from './agentExecutor.iterationDeadline';

describe('runIterationWithDeadlineGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the iteration result when it settles before the deadline', async () => {
    const selfDispatchContinuation = vi.fn().mockResolvedValue(undefined);

    const outcome = await runIterationWithDeadlineGuard(
      {
        remainingMs: 300_000,
        timeoutBufferMs: 120_000,
        runIteration: async () => 'iteration result',
      },
      { selfDispatchContinuation }
    );

    expect(outcome).toEqual({ kind: 'result', result: 'iteration result' });
    expect(selfDispatchContinuation).not.toHaveBeenCalled();
  });

  it('self-dispatches a continuation instead of failing when the deadline aborts the in-flight call', async () => {
    const selfDispatchContinuation = vi.fn().mockResolvedValue(undefined);
    // remainingMs a little above timeoutBufferMs so the timer fires almost immediately -
    // pins the arithmetic (remainingMs - timeoutBufferMs) as well as the abort handling.
    const remainingMs = 120_500;
    const timeoutBufferMs = 120_000;

    const runIteration = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('LLM call aborted')));
        })
    );

    const outcomePromise = runIterationWithDeadlineGuard(
      { remainingMs, timeoutBufferMs, runIteration },
      {
        selfDispatchContinuation,
      }
    );

    await vi.advanceTimersByTimeAsync(remainingMs - timeoutBufferMs);
    const outcome = await outcomePromise;

    expect(outcome).toEqual({ kind: 'handed-off' });
    expect(selfDispatchContinuation).toHaveBeenCalledTimes(1);
    expect(runIteration).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('rethrows a non-deadline failure without self-dispatching', async () => {
    const selfDispatchContinuation = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('real iteration failure');

    await expect(
      runIterationWithDeadlineGuard(
        {
          remainingMs: 300_000,
          timeoutBufferMs: 120_000,
          runIteration: async () => {
            throw failure;
          },
        },
        { selfDispatchContinuation }
      )
    ).rejects.toBe(failure);

    expect(selfDispatchContinuation).not.toHaveBeenCalled();
  });

  it('clamps a negative remaining budget to an immediate abort instead of a negative timer delay', async () => {
    const selfDispatchContinuation = vi.fn().mockResolvedValue(undefined);
    const runIteration = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('LLM call aborted')));
        })
    );

    const outcomePromise = runIterationWithDeadlineGuard(
      { remainingMs: 1_000, timeoutBufferMs: 120_000, runIteration },
      { selfDispatchContinuation }
    );

    await vi.advanceTimersByTimeAsync(0);
    const outcome = await outcomePromise;

    expect(outcome).toEqual({ kind: 'handed-off' });
    expect(selfDispatchContinuation).toHaveBeenCalledTimes(1);
  });
});

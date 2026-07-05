import { vi } from 'vitest';

export interface RunWithFakeTimersOptions {
  /**
   * Virtual time to advance per iteration. Pick a value larger than the longest
   * single timer the code-under-test schedules (e.g. 5_000 for ~2-3s retry
   * delays, 35_000 for a 30s poll backoff).
   */
  advanceByMs?: number;
  /**
   * Safety cap so a stuck promise (e.g. a missing mock that never resolves)
   * surfaces as a finite test rather than hanging CI. This is a hang detector,
   * not a virtual-time budget - increasing `advanceByMs` is the right knob if
   * the code-under-test legitimately needs more virtual time per iteration.
   * Defaults to 50.
   */
  maxIterations?: number;
}

/**
 * Kick off `promise`, advance fake time in chunks until it settles, then await it.
 *
 * Why a loop instead of `vi.runAllTimersAsync()`: some code paths await
 * `setTimeout(delay)` only after several microtask boundaries (e.g. a poll
 * callback that awaits a status check before scheduling the next backoff), so
 * `runAllTimersAsync` can race and return before the next timer is even
 * scheduled. Advancing in fixed chunks gives microtasks room to settle between
 * each tick.
 *
 * Why `.then(resolve, reject)` instead of `.finally()`: `.finally(cb)` returns
 * a new promise that propagates rejection. If `promise` rejects, that new
 * promise has no `.catch` and Node's `unhandledRejection` handler can fire
 * before the caller's `await promise` observes the rejection, causing flaky
 * failures. The two-arg `.then` here attaches a rejection handler so the
 * rejection is observed; the *original* `promise` reference is what we return,
 * so the caller's `await` still surfaces the error normally.
 */
export async function runWithFakeTimers<T>(
  promise: Promise<T>,
  { advanceByMs = 5_000, maxIterations = 50 }: RunWithFakeTimersOptions = {}
): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < maxIterations && !settled; i++) {
    await vi.advanceTimersByTimeAsync(advanceByMs);
  }
  return promise;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_GRACE_MS, untilStopped } from './interruptible';

describe('untilStopped', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<string>(() => undefined);

  it('passes a result or a rejection straight through when nothing is stopped', async () => {
    const controller = new AbortController();
    await expect(untilStopped(Promise.resolve('ok'), controller.signal, () => false)).resolves.toEqual({
      kind: 'returned',
      value: 'ok',
    });
    const failure = new Error('nope');
    await expect(untilStopped(Promise.reject(failure), controller.signal, () => false)).resolves.toEqual({
      kind: 'threw',
      error: failure,
    });
  });

  it('abandons a call that ignores the stop once the grace has run out', async () => {
    const controller = new AbortController();
    const outcome = untilStopped(never(), controller.signal, () => false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await expect(outcome).resolves.toEqual({ kind: 'abandoned' });
  });

  it('abandons straight away a call started after the stop, once the grace has run out', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = untilStopped(never(), controller.signal, () => false);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await expect(outcome).resolves.toEqual({ kind: 'abandoned' });
  });

  it("keeps a call's own account of the stop when it settles inside the grace", async () => {
    const controller = new AbortController();
    const work = new Promise<string>((_, reject) =>
      controller.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('[killed by SIGTERM]')), 50))
    );
    const outcome = untilStopped(work, controller.signal, () => false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await expect(outcome).resolves.toMatchObject({ kind: 'threw', error: { message: '[killed by SIGTERM]' } });
  });

  it('waits out a call that has started writing, however long it takes', async () => {
    const controller = new AbortController();
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>(resolve => {
      finish = resolve;
    });
    let settled = false;
    const outcome = untilStopped(work, controller.signal, () => true).then(value => {
      settled = true;
      return value;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 10);
    expect(settled).toBe(false);

    finish('Written.');
    await expect(outcome).resolves.toEqual({ kind: 'returned', value: 'Written.' });
  });
});

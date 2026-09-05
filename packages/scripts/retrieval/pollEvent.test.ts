import { describe, expect, it, vi } from 'vitest';
import { pollFor } from './pollEvent';

/** A clock that advances only when the poller sleeps, so no test waits on real wall clock. */
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('pollFor', () => {
  it('returns a value that is already there without sleeping', async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    await expect(pollFor(() => 'ready', { now: clock.now, sleep })).resolves.toBe('ready');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns a value that arrives partway through the wait', async () => {
    const clock = fakeClock();
    const buffer: string[] = [];
    let ticks = 0;
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (++ticks === 3) buffer.push('late');
    };
    await expect(pollFor(() => buffer[0], { now: clock.now, sleep, pollIntervalMs: 10 })).resolves.toBe('late');
    expect(ticks).toBe(3);
  });

  it('returns null once the deadline passes rather than waiting forever', async () => {
    const clock = fakeClock();
    await expect(
      pollFor(() => undefined, { now: clock.now, sleep: clock.sleep, timeoutMs: 50, pollIntervalMs: 10 })
    ).resolves.toBeNull();
  });

  it('still reads a present value at a zero timeout', async () => {
    // The deadline check runs AFTER the read, so a value already in the buffer is never missed by
    // a caller that does not want to wait at all.
    const clock = fakeClock();
    await expect(pollFor(() => 'here', { now: clock.now, sleep: clock.sleep, timeoutMs: 0 })).resolves.toBe('here');
    await expect(pollFor(() => undefined, { now: clock.now, sleep: clock.sleep, timeoutMs: 0 })).resolves.toBeNull();
  });

  it('does not mistake a falsy value for an absent one', async () => {
    // The audit event is an object today, but a poller that tested truthiness would silently spin
    // out the full timeout on a legitimate 0 or empty string.
    const clock = fakeClock();
    await expect(pollFor(() => 0, { now: clock.now, sleep: clock.sleep, timeoutMs: 0 })).resolves.toBe(0);
    await expect(pollFor(() => '', { now: clock.now, sleep: clock.sleep, timeoutMs: 0 })).resolves.toBe('');
  });
});

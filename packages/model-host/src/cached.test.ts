import { describe, expect, it } from 'vitest';
import { cached } from './cached';

describe('cached', () => {
  it('shares one call among concurrent callers and reuses it until it is stale', async () => {
    let now = 0;
    let calls = 0;
    const get = cached(async () => ++calls, 1_000, { now: () => now });
    expect(await Promise.all([get(), get()])).toEqual([1, 1]);
    now = 999;
    expect(await get()).toBe(1);
    now = 1_000;
    expect(await get()).toBe(2);
  });

  it('does not keep a failure', async () => {
    let fail = true;
    const get = cached(async () => {
      if (fail) throw new Error('down');
      return 'up';
    }, 60_000);
    await expect(get()).rejects.toThrow('down');
    fail = false;
    expect(await get()).toBe('up');
  });

  it('fails a load that hangs past its deadline and lets the next call start a new one', async () => {
    let calls = 0;
    const get = cached(() => (++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('fresh')), 60_000, {
      timeoutMs: 30,
      timeoutError: () => new Error('slow'),
    });
    await expect(Promise.all([get(), get()])).rejects.toThrow('slow');
    expect(await get()).toBe('fresh');
    expect(calls).toBe(2);
  });
});

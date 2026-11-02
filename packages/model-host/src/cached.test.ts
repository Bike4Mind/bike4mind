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

  it('fails a load that hangs past its deadline and starts no other until it settles', async () => {
    let calls = 0;
    let finish: (value: string) => void = () => {};
    const get = cached(
      () => (++calls === 1 ? new Promise<string>(resolve => (finish = resolve)) : Promise.resolve('fresh')),
      60_000,
      { timeoutMs: 30, timeoutError: () => new Error('slow') }
    );
    await expect(Promise.all([get(), get()])).rejects.toThrow('slow');
    await expect(get()).rejects.toThrow('slow');
    expect(calls).toBe(1);
    finish('late');
    await new Promise(resolve => setImmediate(resolve));
    expect(await get()).toBe('late');
    expect(calls).toBe(1);
  });

  it('starts a new load once a timed-out one fails', async () => {
    let calls = 0;
    let fail: (error: Error) => void = () => {};
    const get = cached(
      () => (++calls === 1 ? new Promise<string>((_, reject) => (fail = reject)) : Promise.resolve('fresh')),
      60_000,
      { timeoutMs: 30, timeoutError: () => new Error('slow') }
    );
    await expect(get()).rejects.toThrow('slow');
    fail(new Error('gave up'));
    await new Promise(resolve => setImmediate(resolve));
    expect(await get()).toBe('fresh');
    expect(calls).toBe(2);
  });
});

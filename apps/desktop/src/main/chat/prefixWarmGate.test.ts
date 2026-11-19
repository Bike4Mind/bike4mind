import { describe, expect, it, vi } from 'vitest';
import { PrefixWarmGate, prefixKey } from './prefixWarmGate';

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise(resolve => setTimeout(resolve, 0));
  return done;
}

describe('PrefixWarmGate', () => {
  it('holds a request with the same key until the leader releases', async () => {
    const gate = new PrefixWarmGate();
    const release = await gate.enter('k');
    const follower = gate.enter('k');
    expect(await settled(follower)).toBe(false);
    release();
    expect(await settled(follower)).toBe(true);
  });

  it('never holds a request with another key', async () => {
    const gate = new PrefixWarmGate();
    await gate.enter('a');
    expect(await settled(gate.enter('b'))).toBe(true);
  });

  it('lets a request through once the leader has released', async () => {
    const gate = new PrefixWarmGate();
    (await gate.enter('k'))();
    expect(await settled(gate.enter('k'))).toBe(true);
  });

  it('stops waiting at the bound or on abort', async () => {
    vi.useFakeTimers();
    try {
      const gate = new PrefixWarmGate(1000);
      await gate.enter('k');
      const timedOut = gate.enter('k');
      const controller = new AbortController();
      const aborted = gate.enter('k', controller.signal);
      controller.abort();
      await expect(aborted).resolves.toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(timedOut).resolves.toBeTypeOf('function');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('prefixKey', () => {
  it('ignores the per-session tail of the system prompt', () => {
    const left = prefixKey('m', [{ name: 't' }], { role: 'system', content: 'shared\nleft', cacheSplitAt: 7 });
    const right = prefixKey('m', [{ name: 't' }], { role: 'system', content: 'shared\nright', cacheSplitAt: 7 });
    expect(left).toBe(right);
  });

  it('separates models, tools and the shared prompt', () => {
    const base = prefixKey('m', [{ name: 't' }], { role: 'system', content: 'shared' });
    expect(prefixKey('n', [{ name: 't' }], { role: 'system', content: 'shared' })).not.toBe(base);
    expect(prefixKey('m', [{ name: 'u' }], { role: 'system', content: 'shared' })).not.toBe(base);
    expect(prefixKey('m', [{ name: 't' }], { role: 'system', content: 'other' })).not.toBe(base);
  });
});

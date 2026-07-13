import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cache } = vi.hoisted(() => ({
  cache: {
    findByKey: vi.fn(),
    tryIncrementWithinLimitFixedWindow: vi.fn(),
    deleteByKey: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@bike4mind/database', () => ({ cacheRepository: cache }));

import {
  checkLock,
  recordFailure,
  clear,
  PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
  PASSPHRASE_LOCKOUT_WINDOW_MS,
} from './passphraseLockout';

const KEY = 'publish-gate-pp-lock:pub1';

beforeEach(() => {
  cache.findByKey.mockReset();
  cache.tryIncrementWithinLimitFixedWindow.mockReset();
  cache.deleteByKey.mockReset().mockResolvedValue(undefined);
});

describe('checkLock', () => {
  it('is unlocked when no counter exists', async () => {
    cache.findByKey.mockResolvedValue(null);
    expect(await checkLock('pub1')).toEqual({ locked: false, retryAfterMs: 0 });
    expect(cache.findByKey).toHaveBeenCalledWith(KEY);
  });

  it('is unlocked while under the cap', async () => {
    cache.findByKey.mockResolvedValue({
      result: { count: PASSPHRASE_LOCKOUT_MAX_ATTEMPTS - 1 },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await checkLock('pub1')).toEqual({ locked: false, retryAfterMs: 0 });
  });

  it('is locked at/over the cap with time remaining', async () => {
    const expiresAt = new Date(Date.now() + 120_000);
    cache.findByKey.mockResolvedValue({ result: { count: PASSPHRASE_LOCKOUT_MAX_ATTEMPTS }, expiresAt });
    const state = await checkLock('pub1');
    expect(state.locked).toBe(true);
    expect(state.retryAfterMs).toBeGreaterThan(0);
    expect(state.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('is unlocked once the window has expired even at the cap', async () => {
    cache.findByKey.mockResolvedValue({
      result: { count: PASSPHRASE_LOCKOUT_MAX_ATTEMPTS + 3 },
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await checkLock('pub1')).toEqual({ locked: false, retryAfterMs: 0 });
  });

  it('never mutates the counter (read-only peek)', async () => {
    cache.findByKey.mockResolvedValue(null);
    await checkLock('pub1');
    expect(cache.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(cache.deleteByKey).not.toHaveBeenCalled();
  });
});

describe('recordFailure', () => {
  it('does not lock while the incremented count stays under the cap', async () => {
    cache.tryIncrementWithinLimitFixedWindow.mockResolvedValue({
      success: true,
      count: 1,
      expiresAt: new Date(Date.now() + PASSPHRASE_LOCKOUT_WINDOW_MS),
    });
    expect(await recordFailure('pub1')).toEqual({ locked: false, retryAfterMs: 0 });
    expect(cache.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      KEY,
      PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
      PASSPHRASE_LOCKOUT_WINDOW_MS
    );
  });

  it('locks on the failure that reaches the cap', async () => {
    const expiresAt = new Date(Date.now() + PASSPHRASE_LOCKOUT_WINDOW_MS);
    cache.tryIncrementWithinLimitFixedWindow.mockResolvedValue({
      success: true,
      count: PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
      expiresAt,
    });
    const state = await recordFailure('pub1');
    expect(state.locked).toBe(true);
    expect(state.retryAfterMs).toBeGreaterThan(0);
  });

  it('locks when the window is already at the cap (increment refused)', async () => {
    const expiresAt = new Date(Date.now() + 30_000);
    cache.tryIncrementWithinLimitFixedWindow.mockResolvedValue({
      success: false,
      count: PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
      expiresAt,
    });
    const state = await recordFailure('pub1');
    expect(state.locked).toBe(true);
    expect(state.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('clear', () => {
  it('deletes the per-artifact counter', async () => {
    await clear('pub1');
    expect(cache.deleteByKey).toHaveBeenCalledWith(KEY);
  });
});

describe('key isolation', () => {
  it('namespaces per artifact so one gate cannot lock another', async () => {
    cache.findByKey.mockResolvedValue(null);
    await checkLock('pubA');
    await checkLock('pubB');
    expect(cache.findByKey).toHaveBeenNthCalledWith(1, 'publish-gate-pp-lock:pubA');
    expect(cache.findByKey).toHaveBeenNthCalledWith(2, 'publish-gate-pp-lock:pubB');
  });
});

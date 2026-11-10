import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import {
  enforceFileEmbeddingSpendWindow,
  resetFileEmbeddingSpendWindow,
  FileEmbeddingLimitResolutionError,
  FileEmbeddingSpendDeniedError,
  fileEmbeddingWindowCacheKeys,
} from './enforceFileEmbeddingSpendWindow';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/** Models the CacheRepository fixed-window and dedup methods against a controllable clock. */
function makeFixedWindowCache(clock: { now: number }) {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const dedup = new Map<string, { data: Record<string, unknown>; expiresAt: number }>();
  const liveDedup = (key: string) => {
    const entry = dedup.get(key);
    return entry && entry.expiresAt > clock.now ? entry : undefined;
  };
  return {
    windows,
    dedup,
    claimDedup: vi.fn(async (key: string, data: Record<string, unknown>, ttlMs: number) => {
      const live = liveDedup(key);
      if (live) return { claimed: false, existingData: live.data };
      dedup.set(key, { data, expiresAt: clock.now + ttlMs });
      return { claimed: true };
    }),
    readDedup: vi.fn(async (key: string) => liveDedup(key)?.data ?? null),
    deleteByKey: vi.fn(async (key: string) => {
      windows.delete(key);
      dedup.delete(key);
    }),
    findByKey: vi.fn(async (key: string) => {
      const window = windows.get(key);
      return window ? { key, result: { count: window.count }, expiresAt: new Date(window.expiresAt) } : null;
    }),
    tryAddWithinLimitFixedWindow: vi.fn(async (key: string, amount: number, limit: number, ttlMs: number) => {
      const live = windows.get(key);
      const window = live && live.expiresAt > clock.now ? live : { count: 0, expiresAt: clock.now + ttlMs };
      if (amount <= 0) return { success: true, count: window.count, expiresAt: new Date(window.expiresAt) };
      if (window.count + amount > limit) {
        return { success: false, count: window.count, expiresAt: new Date(window.expiresAt) };
      }
      window.count += amount;
      windows.set(key, window);
      return { success: true, count: window.count, expiresAt: new Date(window.expiresAt) };
    }),
    releaseFromFixedWindow: vi.fn(async (key: string, amount: number, expiresAt: Date) => {
      const live = windows.get(key);
      if (live && live.expiresAt > clock.now && live.expiresAt === expiresAt.getTime())
        live.count = Math.max(0, live.count - amount);
    }),
  };
}

function makeAdminSettings(values: Record<string, string> = {}) {
  const rows = Object.entries(values).map(([settingName, settingValue]) => ({ settingName, settingValue }));
  return {
    findAll: vi.fn(async () => rows),
    findBySettingNames: vi.fn(async (names: string[]) => rows.filter(r => names.includes(r.settingName))),
  };
}

function setup(settings: Record<string, string> = {}) {
  const clock = { now: T0 };
  const cache = makeFixedWindowCache(clock);
  const db = { adminSettings: makeAdminSettings(settings) as never, cache };
  let nextReservation = 0;
  const reserve = (userId: string, estimatedTokens: number, estimatedMicroUsd = 1, reservationId?: string) =>
    enforceFileEmbeddingSpendWindow({
      userId,
      reservationId: reservationId ?? `work-${(nextReservation += 1)}`,
      estimatedTokens,
      estimatedMicroUsd,
      db,
    });
  return { clock, cache, db, reserve };
}

const denial = async (promise: Promise<unknown>): Promise<FileEmbeddingSpendDeniedError> => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(FileEmbeddingSpendDeniedError);
  return err as FileEmbeddingSpendDeniedError;
};

beforeEach(() => {
  invalidateSettingsCache();
});

describe('enforceFileEmbeddingSpendWindow', () => {
  it('allows reservations until the window is spent, then refuses with the reset time', async () => {
    const { reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });

    await expect(reserve('u1', 600)).resolves.toBeDefined();
    const err = await denial(reserve('u1', 600));

    expect(err.reason).toBe('exhausted');
    expect(err.resetsAt).toEqual(new Date(T0 + 24 * HOUR_MS));
    expect(err.message).toContain('Re-index the file after Jan 2, 2026, 12:00 AM UTC.');
    await expect(reserve('u1', 400)).resolves.toBeDefined();
  });

  it('grants again once the window rolls over', async () => {
    const { clock, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 1000);
    await denial(reserve('u1', 1));

    clock.now = T0 + 24 * HOUR_MS + 1;

    await expect(reserve('u1', 1000)).resolves.toBeDefined();
  });

  it('meters each user separately', async () => {
    const { reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 1000);

    await expect(reserve('u2', 1000)).resolves.toBeDefined();
    await denial(reserve('u1', 1));
  });

  it('refuses on the USD window even when tokens remain', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserBudgetPerWindowUsd: '0.001' });

    await expect(reserve('u1', 10, 800)).resolves.toBeDefined();
    const err = await denial(reserve('u1', 10, 800));

    expect(err.reason).toBe('exhausted');
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').microUsd)?.count).toBe(800);
    // The refused call's token reservation is given back, so only the granted call's 10 remain.
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(10);
  });

  it('gives both reservations back when the grant is released', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    const grant = await reserve('u1', 1000, 500);

    await grant.release();

    const keys = fileEmbeddingWindowCacheKeys('u1');
    expect(cache.windows.get(keys.tokens)?.count).toBe(0);
    expect(cache.windows.get(keys.microUsd)?.count).toBe(0);
    await expect(reserve('u1', 1000)).resolves.toBeDefined();
  });

  it('refuses a single reservation larger than the whole window without touching the meters', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });

    const err = await denial(reserve('u1', 1001));

    expect(err.reason).toBe('oversized');
    expect(err.resetsAt).toBeUndefined();
    expect(cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it.each([['fileEmbeddingUserTokensPerWindow'], ['fileEmbeddingUserBudgetPerWindowUsd']])(
    'treats %s = 0 as a pause, even for an unpriced model',
    async key => {
      const { reserve } = setup({ [key]: '0' });

      const err = await denial(reserve('u1', 1, 0));

      expect(err.reason).toBe('paused');
    }
  );

  it('uses the defaults when no setting is stored', async () => {
    const { reserve } = setup();

    await expect(reserve('u1', FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT)).resolves.toBeDefined();
    const err = await denial(reserve('u1', 1));
    expect(err.resetsAt).toEqual(new Date(T0 + 24 * HOUR_MS));
  });

  it('honours an admin override of the window length', async () => {
    const { clock, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000', fileEmbeddingUserWindowHours: '2' });
    await reserve('u1', 1000);

    const err = await denial(reserve('u1', 1));
    expect(err.resetsAt).toEqual(new Date(T0 + 2 * HOUR_MS));

    clock.now = T0 + 2 * HOUR_MS + 1;
    await expect(reserve('u1', 1000)).resolves.toBeDefined();
  });

  it('fails closed on an invalid stored value', async () => {
    const { reserve } = setup({ fileEmbeddingUserTokensPerWindow: 'lots' });

    await expect(reserve('u1', 1)).rejects.toBeInstanceOf(FileEmbeddingLimitResolutionError);
  });

  it('clamps a stored value above the ceiling instead of honouring it', async () => {
    const { reserve } = setup({ fileEmbeddingUserWindowHours: '100000', fileEmbeddingUserTokensPerWindow: '10' });
    await reserve('u1', 10);

    const err = await denial(reserve('u1', 1));
    expect(err.resetsAt).toEqual(new Date(T0 + 720 * HOUR_MS));
  });

  it('fails closed when the settings cannot be read', async () => {
    const { db, reserve } = setup();
    (db.adminSettings as { findBySettingNames: ReturnType<typeof vi.fn> }).findBySettingNames.mockRejectedValueOnce(
      new Error('db down')
    );
    (db.adminSettings as { findAll: ReturnType<typeof vi.fn> }).findAll.mockRejectedValueOnce(new Error('db down'));

    await expect(reserve('u1', 1)).rejects.toBeInstanceOf(FileEmbeddingLimitResolutionError);
  });

  it('gives the tokens back when the USD claim throws', async () => {
    const { cache, reserve } = setup();
    cache.tryAddWithinLimitFixedWindow
      .mockImplementationOnce(async (_k, _a, _l, ttlMs) => ({
        success: true,
        count: 5,
        expiresAt: new Date(T0 + ttlMs),
      }))
      .mockRejectedValueOnce(new Error('cache down'));

    await expect(reserve('u1', 5)).rejects.toThrow('cache down');

    expect(cache.releaseFromFixedWindow).toHaveBeenCalledWith(
      fileEmbeddingWindowCacheKeys('u1').tokens,
      5,
      expect.any(Date)
    );
  });

  it('still reports the denial when the token rollback fails', async () => {
    const { reserve, cache } = setup({ fileEmbeddingUserBudgetPerWindowUsd: '1' });
    await reserve('u1', 1, 1_000_000);
    cache.releaseFromFixedWindow.mockRejectedValueOnce(new Error('cache down'));
    expect((await denial(reserve('u1', 1, 1_000_000))).reason).toBe('exhausted');
  });

  it('releases the USD window even when the tokens release fails', async () => {
    const { cache, reserve } = setup();
    const grant = await reserve('u1', 5, 7);
    cache.releaseFromFixedWindow.mockRejectedValueOnce(new Error('cache down'));

    await expect(grant.release()).rejects.toThrow('cache down');

    expect(cache.releaseFromFixedWindow).toHaveBeenCalledWith(
      fileEmbeddingWindowCacheKeys('u1').microUsd,
      7,
      expect.any(Date)
    );
  });

  it('reuses the reservation of a redelivered message instead of taking a second one', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 600, 1, 'file-1:abc');

    // The first delivery crashed before releasing; the redelivery is not refused or charged again.
    const redelivery = await reserve('u1', 600, 1, 'file-1:abc');
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(600);

    await redelivery.release();
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(0);
    // Released work reserves afresh on its next delivery.
    await reserve('u1', 600, 1, 'file-1:abc');
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(600);
  });

  it('keeps only one reservation when two deliveries of the same work race', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await Promise.all([reserve('u1', 400, 1, 'file-1:abc'), reserve('u1', 400, 1, 'file-1:abc')]);

    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(400);
  });

  it('meters different work for one file separately', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 400, 1, 'file-1:abc');
    await reserve('u1', 400, 1, 'file-1:def');

    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(800);
  });
});

describe('resetFileEmbeddingSpendWindow', () => {
  // The reset reads window liveness against the real clock; pin it to the fake cache's clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('empties the user windows, reports what they held, and leaves other users alone', async () => {
    const { db, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 1000, 300);
    await reserve('u2', 500, 1);

    await expect(resetFileEmbeddingSpendWindow('u1', db)).resolves.toEqual({ tokens: 1000, microUsd: 300 });

    await expect(reserve('u1', 1000)).resolves.toBeDefined();
    await denial(reserve('u2', 501));
  });

  it('makes a release of a hold from before the reset a no-op', async () => {
    const { clock, cache, db, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    const stale = await reserve('u1', 600);
    await resetFileEmbeddingSpendWindow('u1', db);
    clock.now += 1;
    await reserve('u1', 300);

    await stale.release();

    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').tokens)?.count).toBe(300);
  });
});

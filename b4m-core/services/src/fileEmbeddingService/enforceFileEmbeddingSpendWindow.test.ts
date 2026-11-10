import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import {
  enforceFileEmbeddingSpendWindow,
  FileEmbeddingLimitResolutionError,
  FileEmbeddingSpendDeniedError,
  fileEmbeddingWindowCacheKeys,
} from './enforceFileEmbeddingSpendWindow';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/** Models CacheRepository.tryAddWithinLimitFixedWindow against a controllable clock. */
function makeFixedWindowCache(clock: { now: number }) {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    windows,
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
  const reserve = (userId: string, estimatedTokens: number, estimatedMicroUsd = 1) =>
    enforceFileEmbeddingSpendWindow({ userId, estimatedTokens, estimatedMicroUsd, db });
  return { clock, cache, reserve };
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

    await expect(reserve('u1', 600)).resolves.toBeUndefined();
    const err = await denial(reserve('u1', 600));

    expect(err.reason).toBe('exhausted');
    expect(err.resetsAt).toEqual(new Date(T0 + 24 * HOUR_MS));
    expect(err.message).toContain(new Date(T0 + 24 * HOUR_MS).toISOString());
    await expect(reserve('u1', 400)).resolves.toBeUndefined();
  });

  it('grants again once the window rolls over', async () => {
    const { clock, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 1000);
    await denial(reserve('u1', 1));

    clock.now = T0 + 24 * HOUR_MS + 1;

    await expect(reserve('u1', 1000)).resolves.toBeUndefined();
  });

  it('meters each user separately', async () => {
    const { reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000' });
    await reserve('u1', 1000);

    await expect(reserve('u2', 1000)).resolves.toBeUndefined();
    await denial(reserve('u1', 1));
  });

  it('refuses on the USD window even when tokens remain', async () => {
    const { cache, reserve } = setup({ fileEmbeddingUserBudgetPerWindowUsd: '0.001' });

    await expect(reserve('u1', 10, 800)).resolves.toBeUndefined();
    const err = await denial(reserve('u1', 10, 800));

    expect(err.reason).toBe('exhausted');
    expect(cache.windows.get(fileEmbeddingWindowCacheKeys('u1').microUsd)?.count).toBe(800);
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

    await expect(reserve('u1', FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT)).resolves.toBeUndefined();
    const err = await denial(reserve('u1', 1));
    expect(err.resetsAt).toEqual(new Date(T0 + 24 * HOUR_MS));
  });

  it('honours an admin override of the window length', async () => {
    const { clock, reserve } = setup({ fileEmbeddingUserTokensPerWindow: '1000', fileEmbeddingUserWindowHours: '2' });
    await reserve('u1', 1000);

    const err = await denial(reserve('u1', 1));
    expect(err.resetsAt).toEqual(new Date(T0 + 2 * HOUR_MS));

    clock.now = T0 + 2 * HOUR_MS + 1;
    await expect(reserve('u1', 1000)).resolves.toBeUndefined();
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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IScopedSetting, SettingOwnerType, SettingScopeLevel } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { ScopedSettingChangeCooldownError, scopedSettingChangeCacheKey } from './claimScopedSettingChange';
import { clearScopedOverride, writeScopedOverride } from './writeScopedOverride';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const ownerRef = { scopeLevel: SettingScopeLevel.Owner, scopeId: 'u1', ownerType: 'User' as SettingOwnerType };
const otherOwnerRef = { ...ownerRef, scopeId: 'u2' };

/** Models CacheRepository's fixed-window counter and its release against a controllable clock. */
function makeFixedWindowCache(clock: { now: number }) {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    windows,
    tryAddWithinLimitFixedWindow: vi.fn(async (key: string, amount: number, limit: number, ttlMs: number) => {
      const live = windows.get(key);
      const window = live && live.expiresAt > clock.now ? live : { count: 0, expiresAt: clock.now + ttlMs };
      if (window.count + amount > limit) {
        return { success: false, count: window.count, expiresAt: new Date(window.expiresAt) };
      }
      window.count += amount;
      windows.set(key, window);
      return { success: true, count: window.count, expiresAt: new Date(window.expiresAt) };
    }),
    releaseFromFixedWindow: vi.fn(async (key: string, amount: number, expiresAt: Date) => {
      const live = windows.get(key);
      if (live && live.expiresAt > clock.now && live.expiresAt === expiresAt.getTime()) {
        live.count = Math.max(0, live.count - amount);
      }
    }),
  };
}

function setup(settings: Record<string, string> = {}) {
  const clock = { now: T0 };
  const cache = makeFixedWindowCache(clock);
  const overrides: Partial<IScopedSetting>[] = [];
  const matches = (o: Partial<IScopedSetting>, ref: { scopeLevel: string; scopeId: string }, name: string) =>
    o.scopeLevel === ref.scopeLevel && o.scopeId === ref.scopeId && o.settingName === name;
  const scopedSettings = {
    findOverrides: vi.fn(
      async (scopes: { scopeLevel: string; scopeId: string }[], names: string[]) =>
        overrides.filter(o => scopes.some(s => names.some(n => matches(o, s, n)))) as IScopedSetting[]
    ),
    upsertOverride: vi.fn(async (write: Partial<IScopedSetting>) => {
      const i = overrides.findIndex(o => matches(o, write as never, write.settingName as string));
      if (i >= 0) overrides[i] = { ...overrides[i], ...write };
      else overrides.push(write);
      return write as IScopedSetting;
    }),
    clearOverride: vi.fn(async (ref: { scopeLevel: string; scopeId: string; settingName: string }) => {
      const i = overrides.findIndex(o => matches(o, ref, ref.settingName));
      if (i >= 0) overrides.splice(i, 1);
    }),
  };
  const rows = Object.entries(settings).map(([settingName, settingValue]) => ({ settingName, settingValue }));
  const adminSettings = {
    findAll: vi.fn(async () => rows),
    findBySettingNames: vi.fn(async (names: string[]) => rows.filter(r => names.includes(r.settingName))),
  };
  const db = { scopedSettings, changeCooldown: { adminSettings: adminSettings as never, cache, scopedSettings } };
  const write = (value: string, ref = ownerRef) => writeScopedOverride('DefaultChunkSize', ref, value, db);
  const clear = (ref = ownerRef) => clearScopedOverride('DefaultChunkSize', ref, db);
  const stored = (ref = ownerRef) => overrides.find(o => matches(o, ref, 'DefaultChunkSize'))?.settingValue;
  return { clock, cache, db, scopedSettings, write, clear, stored };
}

beforeEach(() => {
  invalidateSettingsCache();
});

describe('DefaultChunkSize change cooldown', () => {
  it('refuses a second change inside the default interval and leaves the stored value alone', async () => {
    const { write, stored } = setup();
    await write('512');

    const err = await write('256').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScopedSettingChangeCooldownError);
    expect((err as ScopedSettingChangeCooldownError).nextChangeAt).toEqual(new Date(T0 + 24 * HOUR_MS));
    expect((err as Error).message.startsWith('[scopedSettings]')).toBe(true);
    expect(stored()).toBe('512');
  });

  it('allows the next change once the interval has passed', async () => {
    const { clock, write, stored } = setup();
    await write('512');
    clock.now = T0 + 24 * HOUR_MS + 1;

    await expect(write('256')).resolves.toBeUndefined();
    expect(stored()).toBe('256');
  });

  it('counts a clear as a change', async () => {
    const { write, clear } = setup();
    await write('512');

    await expect(clear()).rejects.toBeInstanceOf(ScopedSettingChangeCooldownError);
  });

  it('does not spend the cooldown on a write that changes nothing', async () => {
    const { write, clear, cache } = setup();
    await clear();
    await write('512');
    await write('512');

    expect(cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledTimes(1);
  });

  it('keeps each scope owner on its own interval', async () => {
    const { write } = setup();
    await write('512');

    await expect(write('512', otherOwnerRef)).resolves.toBeUndefined();
  });

  it('honours an admin override of the interval', async () => {
    const { clock, write, cache } = setup({ DefaultChunkSizeChangeCooldownHours: '2' });
    await write('512');
    await expect(write('256')).rejects.toBeInstanceOf(ScopedSettingChangeCooldownError);

    clock.now = T0 + 2 * HOUR_MS + 1;
    await expect(write('256')).resolves.toBeUndefined();
    expect(cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      scopedSettingChangeCacheKey('DefaultChunkSize', ownerRef),
      1,
      1,
      2 * HOUR_MS,
      { outsideTransaction: true }
    );
  });

  it('turns the cooldown off when the interval is set to 0', async () => {
    const { write, cache } = setup({ DefaultChunkSizeChangeCooldownHours: '0' });
    await write('512');

    await expect(write('256')).resolves.toBeUndefined();
    expect(cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('claims and releases outside the caller transaction', async () => {
    const { cache, write, scopedSettings } = setup();
    scopedSettings.upsertOverride.mockRejectedValueOnce(new Error('db down'));

    await expect(write('512')).rejects.toThrow('db down');

    expect(cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(expect.any(String), 1, 1, 24 * HOUR_MS, {
      outsideTransaction: true,
    });
    expect(cache.releaseFromFixedWindow).toHaveBeenCalledWith(expect.any(String), 1, expect.any(Date), {
      outsideTransaction: true,
    });
  });

  it('gives the slot back when the write itself fails', async () => {
    const { write, scopedSettings } = setup();
    scopedSettings.upsertOverride.mockRejectedValueOnce(new Error('db down'));

    await expect(write('512')).rejects.toThrow('db down');
    await expect(write('512')).resolves.toBeUndefined();
  });

  it('gives the slot back when the afterWrite hook throws, so the next claim reuses the same window', async () => {
    const { clock, db } = setup();
    const afterWrite = vi.fn().mockRejectedValueOnce(new Error('audit down'));

    await expect(writeScopedOverride('DefaultChunkSize', ownerRef, '512', db, { afterWrite })).rejects.toThrow(
      'audit down'
    );

    clock.now = T0 + 10 * HOUR_MS;
    await expect(writeScopedOverride('DefaultChunkSize', ownerRef, '256', db, { afterWrite })).resolves.toBeUndefined();
    expect(afterWrite).toHaveBeenCalledTimes(2);

    clock.now = T0 + 23 * HOUR_MS;
    await expect(writeScopedOverride('DefaultChunkSize', ownerRef, '128', db)).rejects.toBeInstanceOf(
      ScopedSettingChangeCooldownError
    );
  });

  it('gives the slot back when the afterWrite hook throws on a clear', async () => {
    const { db, scopedSettings } = setup();
    await scopedSettings.upsertOverride({ ...ownerRef, settingName: 'DefaultChunkSize', settingValue: '512' });
    const afterWrite = vi.fn().mockRejectedValueOnce(new Error('audit down'));

    await expect(clearScopedOverride('DefaultChunkSize', ownerRef, db, { afterWrite })).rejects.toThrow('audit down');
    await expect(clearScopedOverride('DefaultChunkSize', ownerRef, db, { afterWrite })).resolves.toBeUndefined();
  });

  it('refuses to write a cooldown key when the writer omits the cooldown dependencies', async () => {
    const { scopedSettings } = setup();

    await expect(writeScopedOverride('DefaultChunkSize', ownerRef, '512', { scopedSettings })).rejects.toThrow(
      /change cooldown/
    );
    expect(scopedSettings.upsertOverride).not.toHaveBeenCalled();
  });

  it('leaves keys without a cooldown untouched', async () => {
    const { db, cache } = setup();

    await writeScopedOverride('dataLakeSearchMaxFiles', ownerRef, '10', { scopedSettings: db.scopedSettings });
    await writeScopedOverride('dataLakeSearchMaxFiles', ownerRef, '20', { scopedSettings: db.scopedSettings });

    expect(cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });
});

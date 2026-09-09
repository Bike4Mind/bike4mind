import { describe, it, expect, vi } from 'vitest';
import { AdminSettingsCache, type PartialAdminSettingsLogger } from './AdminSettingsCache';

describe('AdminSettingsCache tolerates a partial logger', () => {
  /**
   * The shape callers actually pass. `Logger` declares debug/info/warn/error, but this cache is a
   * process-wide singleton created with whichever logger reaches `getSettingsCache` first - in
   * practice often a hand-rolled test double or an adapter carrying only the levels its author
   * needed. What callers do with a throw varies - `getSettingsByNames` has no guard at all, the
   * scoped resolver guards one layer out, `resolveSpendLevers` rethrows to halt spend - so a cache
   * that threw while logging could surface as a silent wrong value or as an unhandled rejection.
   */
  // Typed as the widened parameter, not cast through `Logger`: the cast would pass whether or not
  // the constructor actually accepts a partial logger, so it would assert nothing about the widening.
  const partialLogger: PartialAdminSettingsLogger = { warn: vi.fn(), error: vi.fn() };

  it('invalidateAll still clears the cache instead of throwing on a missing log level', () => {
    const cache = new AdminSettingsCache(partialLogger);
    expect(() => cache.invalidateAll()).not.toThrow();
    expect(cache.getStats().totalEntries).toBe(0);
  });

  it('invalidateSetting does not throw on a missing log level', () => {
    const cache = new AdminSettingsCache(partialLogger);
    expect(() => cache.invalidateSetting('forcedRetrievalRelativeFloorPct')).not.toThrow();
  });
});

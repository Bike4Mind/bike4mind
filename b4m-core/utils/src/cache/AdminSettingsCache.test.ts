import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { AdminSettingsCache } from './AdminSettingsCache';

describe('AdminSettingsCache tolerates a partial logger', () => {
  /**
   * The shape callers actually pass. `Logger` declares debug/info/warn/error, but this cache is a
   * process-wide singleton created with whichever logger reaches `getSettingsCache` first - in
   * practice often a hand-rolled test double or an adapter carrying only the levels its author
   * needed. Every caller wraps its settings read in a never-throw guard that degrades to coded
   * defaults, so a cache that threw while logging turned a good read into a silent wrong value.
   */
  const partialLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

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

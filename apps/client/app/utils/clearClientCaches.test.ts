import { describe, it, expect, beforeEach, vi } from 'vitest';

// The generated glue is empty in the open-core tree, so the sweep has nothing to do
// unless a contribution is stubbed in - mock it to stand in for an installed overlay.
// The array identity is stable, so each test mutates it in place via setPrefixes().
const { premiumLocalStorageKeyPrefixes } = vi.hoisted(() => ({
  premiumLocalStorageKeyPrefixes: [] as string[],
}));
vi.mock('../premium-generated/premiumLocalStorageKeys.generated', () => ({
  premiumLocalStorageKeyPrefixes,
}));

vi.mock('idb-keyval', () => ({ del: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./dexie', () => ({ dexie: { delete: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./tagCache', () => ({ tagCacheManager: { clearAllCaches: vi.fn().mockResolvedValue(undefined) } }));

import { clearClientCaches } from './clearClientCaches';

function setPrefixes(prefixes: string[]) {
  premiumLocalStorageKeyPrefixes.length = 0;
  premiumLocalStorageKeyPrefixes.push(...prefixes);
}

beforeEach(() => {
  localStorage.clear();
  setPrefixes([]);
});

describe('clearClientCaches premium localStorage sweep', () => {
  it('removes every key under a declared prefix, including per-identity variants', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('overlay-panel:', 'legacy-global');
    localStorage.setItem('overlay-panel:user-a', 'a');
    localStorage.setItem('overlay-panel:user-b', 'b');

    await clearClientCaches();

    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('leaves keys no overlay declared alone', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('overlay-panel:user-a', 'a');
    localStorage.setItem('unrelated-app-setting', 'keep me');
    // Near-miss: the prefix must match at the START of the key, not anywhere in it.
    localStorage.setItem('not-an-overlay-panel:user-a', 'keep me too');

    await clearClientCaches();

    expect(Object.keys(localStorage).sort()).toEqual(['not-an-overlay-panel:user-a', 'unrelated-app-setting']);
  });

  it('is a no-op for the open-core tree, where no overlay declares a prefix', async () => {
    localStorage.setItem('some-other-key', 'value');

    await clearClientCaches();

    expect(localStorage.getItem('some-other-key')).toBe('value');
  });

  it('still clears the core allowlist alongside the sweep', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('user-context', 'stale');
    localStorage.setItem('artifacts', 'stale');
    localStorage.setItem('overlay-panel:user-a', 'stale');

    await clearClientCaches();

    expect(Object.keys(localStorage)).toEqual([]);
  });
});

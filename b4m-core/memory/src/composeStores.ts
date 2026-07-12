import type { MemoryStore } from './store';
import type { MemoryProfile, Principal } from './types';

/**
 * Compose stores into one that returns the first non-null profile, tried in order. Lets a single
 * principal kind be served by more than one backend - e.g. an agent id that may resolve to a
 * DeepAgent charter OR a persona-agent journal. Ownership/scope is each store's own responsibility.
 */
export function firstMatchStore(stores: MemoryStore[]): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      for (const store of stores) {
        const profile = await store.readProfile(principal);
        if (profile) return profile;
      }
      return null;
    },
  };
}

/**
 * Compose stores into one that UNIONS every non-null profile's beliefs, tried in order. This is the
 * Mementos V2 read seam: a user's memory is the ledger PLUS their legacy V1 mementos, so V2 surfaces
 * everything they have without a backfill. Beliefs are de-duplicated by `id` (earlier stores win, so
 * a ledger belief takes precedence over a same-id memento); the profile's identity fields come from
 * the first store that answered. Returns null only when every store returns null.
 */
export function mergeStores(stores: MemoryStore[]): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      const profiles = (await Promise.all(stores.map(s => s.readProfile(principal)))).filter(
        (p): p is MemoryProfile => p !== null
      );
      if (profiles.length === 0) return null;

      const seen = new Set<string>();
      const beliefs = [];
      for (const profile of profiles) {
        for (const belief of profile.beliefs) {
          if (seen.has(belief.id)) continue;
          seen.add(belief.id);
          beliefs.push(belief);
        }
      }
      // Most active first, matching the fold's own ordering.
      beliefs.sort((a, b) => (b.activation ?? 0) - (a.activation ?? 0) || a.id.localeCompare(b.id));
      return { ...profiles[0], principal, beliefs };
    },
  };
}

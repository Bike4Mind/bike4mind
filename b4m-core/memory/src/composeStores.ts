import { subjectKey } from './subject';
import type { MemoryStore } from './store';
import type { Belief, MemoryProfile, Principal } from './types';

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
 * De-dup key for a merged belief: the normalized content of the fact, so the SAME fact coming from
 * two sources (a V2 ledger belief and its V1 memento twin, which carry different ids) collapses into
 * one. Shredded beliefs have a redaction placeholder for a fact, so they fall back to their own id -
 * otherwise every shredded ghost would normalize to the same key and collapse into a single row.
 */
const dedupKey = (b: Belief): string => (b.shredded ? b.id : subjectKey(b.fact) || b.id);

/**
 * Compose stores into one that UNIONS every non-null profile's beliefs, tried in order. This is the
 * Mementos V2 read seam: a user's memory is the ledger PLUS their legacy V1 mementos, so V2 surfaces
 * everything they have without a backfill. Beliefs are de-duplicated by normalized fact content
 * (earlier stores win, so a ledger belief takes precedence over its V1 memento twin); the profile's
 * identity fields come from the first store that answered. Returns null only when all stores do.
 */
export function mergeStores(stores: MemoryStore[]): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      const profiles = (await Promise.all(stores.map(s => s.readProfile(principal)))).filter(
        (p): p is MemoryProfile => p !== null
      );
      if (profiles.length === 0) return null;

      const seen = new Set<string>();
      const beliefs: Belief[] = [];
      for (const profile of profiles) {
        for (const belief of profile.beliefs) {
          const key = dedupKey(belief);
          if (seen.has(key)) continue;
          seen.add(key);
          beliefs.push(belief);
        }
      }
      // Most active first, matching the fold's own ordering.
      beliefs.sort((a, b) => (b.activation ?? 0) - (a.activation ?? 0) || a.id.localeCompare(b.id));
      return { ...profiles[0], principal, beliefs };
    },
  };
}

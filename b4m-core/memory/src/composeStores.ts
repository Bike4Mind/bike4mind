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

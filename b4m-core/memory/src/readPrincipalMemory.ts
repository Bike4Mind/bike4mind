import type { MemoryProfile, Principal } from './types';
import type { MemoryStore } from './store';

/**
 * The unified read: a principal's push profile, through one interface regardless of whether the
 * principal is a user or an agent. The single public entry point for the push path; the store
 * decides where the bytes come from.
 */
export function readPrincipalMemory(principal: Principal, store: MemoryStore): Promise<MemoryProfile | null> {
  return store.readProfile(principal);
}

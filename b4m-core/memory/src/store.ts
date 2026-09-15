import type { MemoryProfile, Principal } from './types';

/**
 * The memory substrate port. Dependency-inverted so this core package stays a pure leaf: the DB
 * wiring (backed by the DeepAgent repositories, and later the user-memento store) implements it,
 * and tests supply a fake. Grows with the build order - append/list events and the fold land in
 * later steps; step 1 wires only the profile read.
 */
export interface MemoryStore {
  /** The principal's current push profile, or null if none exists yet. */
  readProfile(principal: Principal): Promise<MemoryProfile | null>;
}

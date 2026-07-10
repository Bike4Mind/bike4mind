import {
  userMementosToProfile,
  type MemoryProfile,
  type MemoryStore,
  type Principal,
  type UserMementoLike,
} from '@bike4mind/memory';

/** Owner-scoped read of a user's mementos. Structural; `mementoRepository` satisfies it. */
export interface UserMementoReader {
  findByUserId(userId: string, options: { tier?: string; select?: string }): Promise<UserMementoLike[]>;
}

/**
 * User-memory MemoryStore. Scope isolation: a user may only read their OWN memory, so the principal
 * must be a user whose id equals the requester - reading any other user's memory returns null (404
 * at the endpoint, no existence leak). Reads all non-archived mementos and folds them.
 */
export function createUserMementoMemoryStore(deps: { mementos: UserMementoReader; ownerUserId: string }): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      if (principal.kind !== 'user' || principal.id !== deps.ownerUserId) return null;
      const mementos = await deps.mementos.findByUserId(deps.ownerUserId, {});
      return userMementosToProfile(deps.ownerUserId, mementos);
    },
  };
}

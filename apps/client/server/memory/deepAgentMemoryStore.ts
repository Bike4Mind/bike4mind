import {
  charterToProfile,
  type DeepAgentCharterLike,
  type MemoryProfile,
  type MemoryStore,
  type Principal,
} from '@bike4mind/memory';

/** A DeepAgent charter plus its owner - the minimal read surface this store needs. */
export type OwnedCharter = DeepAgentCharterLike & {
  identity: DeepAgentCharterLike['identity'] & { ownerUserId: string };
};

/**
 * Minimal charter-read dependency (structural, so tests supply a fake and the store takes no direct
 * dependency on the Mongoose model). `deepAgentCharterRepository` satisfies it.
 */
export interface CharterReader {
  findByAgentId(agentId: string): Promise<OwnedCharter | null>;
}

/**
 * DeepAgent-backed MemoryStore, scoped to a single owner. Scope isolation (spec L6) is enforced
 * HERE, not just at the endpoint: an agent's profile is returned only when its charter is owned by
 * `ownerUserId`; a missing charter and a charter owned by someone else are indistinguishable (both
 * null) so the store never leaks the existence of another owner's agent. Non-agent principals
 * return null until their stores are wired (build-order steps 3+).
 */
export function createDeepAgentMemoryStore(deps: { charters: CharterReader; ownerUserId: string }): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      if (principal.kind !== 'agent') return null;
      const charter = await deps.charters.findByAgentId(principal.id);
      if (!charter || charter.identity.ownerUserId !== deps.ownerUserId) return null;
      return charterToProfile(charter);
    },
  };
}

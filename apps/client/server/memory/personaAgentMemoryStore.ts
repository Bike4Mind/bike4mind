import {
  personaAgentToProfile,
  type MemoryProfile,
  type MemoryStore,
  type PersonaAgentLike,
  type Principal,
} from '@bike4mind/memory';

/**
 * Owner-scoped read of a persona agent (AgentModel). Structural so tests supply a fake;
 * `agentRepository` satisfies it. `findByIdAndUserId` enforces ownership (returns null unless the
 * agent belongs to the user), so scope isolation lives in the repo method.
 */
export interface PersonaAgentReader {
  findByIdAndUserId(id: string, userId: string): Promise<PersonaAgentLike | null>;
}

export function createPersonaAgentMemoryStore(deps: { agents: PersonaAgentReader; ownerUserId: string }): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      if (principal.kind !== 'agent') return null;
      const agent = await deps.agents.findByIdAndUserId(principal.id, deps.ownerUserId);
      return agent ? personaAgentToProfile(agent) : null;
    },
  };
}

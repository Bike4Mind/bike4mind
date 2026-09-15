import type { Belief, MemoryProfile, Principal } from '../types';

/**
 * Structural mirror of the fields we read off a DeepAgent Charter (see DeepAgentCharterModel in
 * @bike4mind/database). Declared locally so this core package takes no dependency on the DB /
 * agents packages - any real charter satisfies it structurally. Keep in sync with that model.
 */
export interface DeepAgentCharterLike {
  identity: { agentId: string; name: string; role: string };
  semanticMemory: Array<{
    id: string;
    fact: string;
    evidenceTier: Belief['evidenceTier'];
    confidence: number;
    sourceEpisodeIds: string[];
    lastAffirmedAt: Date | string;
  }>;
  sizeBudgetBytes: number;
  version: number;
  groomedAt?: Date | string;
}

export function agentPrincipal(agentId: string): Principal {
  return { kind: 'agent', id: agentId };
}

/** Fold a DeepAgent Charter into the principal-scoped MemoryProfile. Lossless for the fields shared. */
export function charterToProfile(charter: DeepAgentCharterLike): MemoryProfile {
  return {
    principal: agentPrincipal(charter.identity.agentId),
    name: charter.identity.name,
    role: charter.identity.role,
    beliefs: charter.semanticMemory.map((m): Belief => ({
      id: m.id,
      fact: m.fact,
      evidenceTier: m.evidenceTier,
      confidence: m.confidence,
      derivedFrom: m.sourceEpisodeIds,
      lastAffirmedAt: toIso(m.lastAffirmedAt),
    })),
    sizeBudgetBytes: charter.sizeBudgetBytes,
    version: charter.version,
    groomedAt: charter.groomedAt === undefined ? undefined : toIso(charter.groomedAt),
  };
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}

import type { Belief, MemoryProfile } from '../types';

/**
 * Structural mirror of the fields we read off an AgentModel (persona agent) in @bike4mind/database.
 * Declared locally so this core package stays a pure leaf. Keep in sync with that model.
 */
export interface PersonaAgentLike {
  id?: string;
  /** Accepts a Mongo ObjectId (has toString) as well as a plain string id. */
  _id?: string | { toString(): string };
  name: string;
  description?: string;
  memoryJournal?: Array<{
    id: string;
    content: string;
    /** 1..5 */
    importance: number;
    source: string;
    timestamp: Date | string;
    tags?: string[];
    relatedEntityIds?: string[];
  }>;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const toIso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());

/**
 * Fold a persona agent's memoryJournal into the principal-scoped MemoryProfile. Lossy by nature:
 * journal entries are unverified working memory, not evidence-graded beliefs, so they land at the
 * lowest tier ('engineering-proxy') with importance (1..5) carried as confidence. This is the DRY
 * seam in action - a second agent-memory source rendered through the same shape as the DeepAgent one.
 */
export function personaAgentToProfile(agent: PersonaAgentLike): MemoryProfile {
  return {
    principal: { kind: 'agent', id: String(agent.id ?? agent._id ?? '') },
    name: agent.name,
    role: agent.description,
    beliefs: (agent.memoryJournal ?? []).map((m): Belief => ({
      id: m.id,
      fact: m.content,
      evidenceTier: 'engineering-proxy',
      confidence: clamp01(m.importance / 5),
      derivedFrom: m.relatedEntityIds && m.relatedEntityIds.length > 0 ? m.relatedEntityIds : [m.source],
      lastAffirmedAt: toIso(m.timestamp),
    })),
  };
}

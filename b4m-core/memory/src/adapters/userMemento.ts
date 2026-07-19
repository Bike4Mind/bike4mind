import type { Belief, MemoryProfile } from '../types';

/**
 * Structural mirror of the fields we read off a user Memento (see MementoModel in
 * @bike4mind/database). Declared locally so this core package stays a pure leaf. Keep in sync.
 */
export interface UserMementoLike {
  id?: string;
  _id?: string | { toString(): string };
  summary: string;
  /** 'hot' | 'warm' | 'cold' */
  tier?: string;
  weight?: number;
  sessionId?: string | null;
  questId?: string;
  lastAccessedAt: Date | string;
  isArchived?: boolean;
  /** The memento's stored summary embedding (V1's vector-search field); carried into the belief. */
  embedding?: number[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const toIso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());
const tierConfidence = (tier?: string, weight?: number): number =>
  tier === 'hot' ? 0.9 : tier === 'warm' ? 0.6 : tier === 'cold' ? 0.3 : clamp01(weight ?? 0.5);
const asSalience = (tier?: string): 'hot' | 'warm' | 'cold' | undefined =>
  tier === 'hot' || tier === 'warm' || tier === 'cold' ? tier : undefined;

/**
 * Fold a user's mementos into the principal-scoped MemoryProfile (principal kind 'user'). Lossy:
 * mementos are LLM-extracted, unverified facts about the user, so they land at the lowest evidence
 * tier; salience tier (hot/warm/cold) maps to confidence and the source session/quest is the
 * provenance. Archived mementos are omitted. Lights up the user kind on the same endpoint as agents.
 */
export function userMementosToProfile(userId: string, mementos: UserMementoLike[]): MemoryProfile {
  return {
    principal: { kind: 'user', id: userId },
    beliefs: mementos
      .filter(m => !m.isArchived)
      .map((m): Belief => ({
        id: String(m.id ?? m._id ?? ''),
        fact: m.summary,
        evidenceTier: 'engineering-proxy',
        confidence: tierConfidence(m.tier, m.weight),
        salience: asSalience(m.tier),
        // The memento already carries the embedding of its summary (V1 computes it at creation for
        // vector search) - carry it through so V2 recall can score topicality semantically.
        ...(m.embedding?.length ? { embedding: m.embedding } : {}),
        derivedFrom: m.sessionId ? [m.sessionId] : m.questId ? [m.questId] : [],
        lastAffirmedAt: toIso(m.lastAccessedAt),
      })),
  };
}

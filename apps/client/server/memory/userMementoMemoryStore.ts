import { mementoEmbeddingIsCurrent } from '@bike4mind/common';
import {
  userMementosToProfile,
  type MemoryProfile,
  type MemoryStore,
  type Principal,
  type UserMementoLike,
} from '@bike4mind/memory';

/** Owner-scoped read of a user's mementos. Structural; `mementoRepository` satisfies it. */
export interface UserMementoReader {
  findByUserId(
    userId: string,
    options: { tier?: string; select?: string }
  ): Promise<(UserMementoLike & { embeddingModel?: string })[]>;
}

/**
 * Exactly the fields `userMementosToProfile` folds - nothing more. Without a projection the read
 * pulls every memento's FULL document, including `fullContent` (the entire original prompt) and any
 * other unused field: kilobytes per memento, over the wire from a remote Mongo, on the chat's
 * critical path, growing without bound as a user accumulates memories. `embedding` is kept - it is
 * what recall scores topicality with - and `embeddingModel` with it, since a vector is uninterpretable
 * without knowing the space it lives in.
 */
const PROFILE_FIELDS =
  'summary tier weight sessionId questId lastAccessedAt isArchived embedding embeddingModel';

/**
 * User-memory MemoryStore. Scope isolation: a user may only read their OWN memory, so the principal
 * must be a user whose id equals the requester - reading any other user's memory returns null (404
 * at the endpoint, no existence leak). Reads all non-archived mementos and folds them.
 */
export function createUserMementoMemoryStore(deps: { mementos: UserMementoReader; ownerUserId: string }): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      if (principal.kind !== 'user' || principal.id !== deps.ownerUserId) return null;
      const mementos = await deps.mementos.findByUserId(deps.ownerUserId, { select: PROFILE_FIELDS });

      // Drop any vector written in a different model's space before it reaches recall. Cosine across
      // spaces is noise, and recall cannot tell noise from a score - it would rank on it. Stripped of
      // its embedding, the belief still recalls via the lexical fallback: degraded, but honest. The
      // re-embed backfill restores it. The memory core stays pure (it knows nothing of embedding
      // models), so this boundary is where the knowledge has to live.
      //
      // Rebuilt field by field rather than spread: these are HYDRATED Mongoose documents, and
      // spreading one copies its internals, not its fields.
      const safe: UserMementoLike[] = mementos.map(m => ({
        id: m.id,
        _id: m._id,
        summary: m.summary,
        tier: m.tier,
        weight: m.weight,
        sessionId: m.sessionId,
        questId: m.questId,
        lastAccessedAt: m.lastAccessedAt,
        isArchived: m.isArchived,
        ...(mementoEmbeddingIsCurrent(m) && m.embedding?.length ? { embedding: m.embedding } : {}),
      }));

      return userMementosToProfile(deps.ownerUserId, safe);
    },
  };
}

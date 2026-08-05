import { MementoTier, mementoEmbeddingIsCurrent } from '@bike4mind/common';
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
    options: { tier?: string; select?: string; limit?: number; afterId?: string }
  ): Promise<(UserMementoLike & { embeddingModel?: string })[]>;
}

/**
 * Page size for the profile read. The fold below has to end up holding every belief - that is what a
 * profile is - but it does not have to hold every HYDRATED Mongoose document at the same time, and
 * those are the expensive half: internals plus an embedding each, on the chat's critical path. Paging
 * keeps one page of documents live and retains only the rebuilt plain objects.
 */
const PROFILE_PAGE_SIZE = 200;
/**
 * Sanity bound, not a coverage budget: a profile is defined as EVERY belief, so stopping short would
 * hand the model a subset of the user's memory presented as complete - and this store has no logger
 * to say so. Hitting it therefore throws. Set far past any real account; reaching it means the
 * repository is misbehaving, which cursor-advance alone cannot detect (advance proves progress, not
 * termination).
 */
const PROFILE_MAX_PAGES = 2_000;

/**
 * Exactly the fields `userMementosToProfile` folds - nothing more. Without a projection the read
 * pulls every memento's FULL document, including `fullContent` (the entire original prompt) and any
 * other unused field: kilobytes per memento, over the wire from a remote Mongo, on the chat's
 * critical path, growing without bound as a user accumulates memories. `embedding` is kept - it is
 * what recall scores topicality with - and `embeddingModel` with it, since a vector is uninterpretable
 * without knowing the space it lives in.
 */
const PROFILE_FIELDS = 'summary tier weight sessionId questId lastAccessedAt isArchived embedding embeddingModel';

/**
 * User-memory MemoryStore. Scope isolation: a user may only read their OWN memory, so the principal
 * must be a user whose id equals the requester - reading any other user's memory returns null (404
 * at the endpoint, no existence leak). Reads all non-archived mementos and folds them.
 */
export function createUserMementoMemoryStore(deps: { mementos: UserMementoReader; ownerUserId: string }): MemoryStore {
  return {
    async readProfile(principal: Principal): Promise<MemoryProfile | null> {
      if (principal.kind !== 'user' || principal.id !== deps.ownerUserId) return null;
      // HOT only, to match V1's own injection gate (getRelevantMementos defaults tier=HOT). Without
      // this, a V2 user's union recall was eligible to surface WARM/COLD V1 mementos that V1
      // deliberately demoted out of the prompt - stale legacy facts leaking back in through the V2 read.
      const safe: UserMementoLike[] = [];
      let cursor: string | undefined;

      for (let page = 0; ; page++) {
        if (page > PROFILE_MAX_PAGES) {
          throw new Error(
            `[userMementoMemoryStore] profile walk exceeded ${PROFILE_MAX_PAGES} pages for ${deps.ownerUserId}; ` +
              `refusing to return a partial profile silently`
          );
        }
        const mementos = await deps.mementos.findByUserId(deps.ownerUserId, {
          tier: MementoTier.HOT,
          select: PROFILE_FIELDS,
          limit: PROFILE_PAGE_SIZE,
          afterId: cursor,
        });
        if (mementos.length === 0) break;

        const nextCursor = String(mementos[mementos.length - 1].id);
        if (cursor !== undefined && !(nextCursor > cursor)) {
          throw new Error(`[userMementoMemoryStore] memento cursor failed to advance past ${cursor}`);
        }
        cursor = nextCursor;

        // Drop any vector written in a different model's space before it reaches recall. Cosine across
        // spaces is noise, and recall cannot tell noise from a score - it would rank on it. Stripped of
        // its embedding, the belief still recalls via the lexical fallback: degraded, but honest. The
        // re-embed backfill restores it. The memory core stays pure (it knows nothing of embedding
        // models), so this boundary is where the knowledge has to live.
        //
        // Rebuilt field by field rather than spread: these are HYDRATED Mongoose documents, and
        // spreading one copies its internals, not its fields. Rebuilding per page is also what lets
        // the page's documents go once it has been folded.
        for (const m of mementos) {
          safe.push({
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
          });
        }

        if (mementos.length < PROFILE_PAGE_SIZE) break;
      }

      return userMementosToProfile(deps.ownerUserId, safe);
    },
  };
}

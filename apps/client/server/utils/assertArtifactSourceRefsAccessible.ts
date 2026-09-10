import { ForbiddenError } from '@server/utils/errors';

/** Caller-supplied provenance refs recorded verbatim on a newly created artifact. */
export interface ArtifactSourceRefs {
  sessionId?: string;
  sourceQuestId?: string;
  parentArtifactId?: string;
}

/**
 * Ownership lookups, injected so this stays a pure, unit-testable guard. Each returns just enough
 * to answer "does `userId` own this ref". Ownership of a quest is transitive through its session:
 * a quest carries no user of its own on the agent-created path, so its owner is the owner of the
 * session it belongs to (top-level `sessionId`), NOT `promptMeta.session.userId` (unset there).
 */
export interface ArtifactRefOwnershipDeps {
  isOwnedSession(sessionId: string, userId: string): Promise<boolean>;
  /** The session a quest belongs to, or null if the quest does not exist. */
  getQuestSessionId(questId: string): Promise<string | null>;
  /** The owning userId of an artifact (by its custom `id`), or null if it does not exist. */
  getArtifactOwner(artifactId: string): Promise<string | null>;
}

/**
 * Reject caller-supplied provenance refs that point outside the caller's own graph. The artifact
 * create endpoint writes `sessionId` / `sourceQuestId` / `parentArtifactId` straight onto the new
 * artifact with the caller's own id as owner, so without this an authenticated user could stamp
 * their artifact as sourced-from / session-of / child-of another user's session, quest, or
 * artifact. Fails loud (403). Each ref is optional and only checked when provided.
 */
export async function assertArtifactSourceRefsOwned(
  userId: string,
  refs: ArtifactSourceRefs,
  deps: ArtifactRefOwnershipDeps
): Promise<void> {
  if (refs.sessionId && !(await deps.isOwnedSession(refs.sessionId, userId))) {
    throw new ForbiddenError('You do not have access to the referenced session');
  }

  if (refs.sourceQuestId) {
    const questSessionId = await deps.getQuestSessionId(refs.sourceQuestId);
    if (!questSessionId || !(await deps.isOwnedSession(questSessionId, userId))) {
      throw new ForbiddenError('You do not have access to the referenced source quest');
    }
  }

  if (refs.parentArtifactId) {
    const owner = await deps.getArtifactOwner(refs.parentArtifactId);
    if (owner !== userId) {
      throw new ForbiddenError('You do not have access to the referenced parent artifact');
    }
  }
}

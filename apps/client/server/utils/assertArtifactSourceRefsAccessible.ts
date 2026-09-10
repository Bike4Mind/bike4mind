import { ForbiddenError } from '@server/utils/errors';

/** Caller-supplied provenance refs recorded verbatim on a newly created artifact. */
export interface ArtifactSourceRefs {
  sessionId?: string;
  sourceQuestId?: string;
  parentArtifactId?: string;
}

/**
 * Access lookups, injected so this stays a pure, unit-testable guard.
 *
 * Sessions are shareable, so the bar is *access*, not ownership: a collaborator working in a
 * session shared with them legitimately creates artifacts stamped with the owner's `sessionId`
 * (see the artifact-persistence paths), and an owner-only check would wrongly 403 that flow.
 * `isAccessibleSession` therefore mirrors the session repo's read-access predicate (owner OR
 * read/write share OR group share) and closes over the caller in the route.
 *
 * A quest carries no user of its own, so its access is transitive through the session it belongs
 * to (top-level `sessionId`): resolve the quest's session, then apply the same access check.
 *
 * Artifacts are NOT shareable (no cross-user artifact flow exists), so `parentArtifactId` stays a
 * strict owner check.
 */
export interface ArtifactRefAccessDeps {
  /** True iff the caller can access the session (owner or shared with them). */
  isAccessibleSession(sessionId: string): Promise<boolean>;
  /** The session a quest belongs to, or null if the quest does not exist. */
  getQuestSessionId(questId: string): Promise<string | null>;
  /** The owning userId of an artifact (by its custom `id`), or null if it does not exist. */
  getArtifactOwner(artifactId: string): Promise<string | null>;
}

/**
 * Reject caller-supplied provenance refs the caller is not entitled to reference. The artifact
 * create endpoint writes `sessionId` / `sourceQuestId` / `parentArtifactId` straight onto the new
 * artifact with the caller's own id as owner, so without this an authenticated user could stamp
 * their artifact as sourced-from / session-of / child-of a session, quest, or artifact they have
 * no access to (an object-level authorization / IDOR gap). Fails loud (403). Each ref is optional
 * and only checked when provided.
 */
export async function assertArtifactSourceRefsAccessible(
  userId: string,
  refs: ArtifactSourceRefs,
  deps: ArtifactRefAccessDeps
): Promise<void> {
  if (refs.sessionId && !(await deps.isAccessibleSession(refs.sessionId))) {
    throw new ForbiddenError('You do not have access to the referenced session');
  }

  if (refs.sourceQuestId) {
    const questSessionId = await deps.getQuestSessionId(refs.sourceQuestId);
    if (!questSessionId || !(await deps.isAccessibleSession(questSessionId))) {
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

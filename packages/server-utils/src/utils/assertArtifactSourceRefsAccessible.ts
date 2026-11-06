import type { artifactService } from '@bike4mind/services';
import { ForbiddenError } from './errors';

/** Same type `artifactService.create` hands its `assertSourceRefsAccessible` adapter. */
export type ArtifactSourceRefs = artifactService.ArtifactSourceRefs;

/**
 * Access lookups, injected so this stays a pure, unit-testable guard.
 *
 * Sessions are shareable, and stamping an artifact with a session is a write into that session's
 * graph - so the bar is *update* access, not ownership and not mere read access. A collaborator
 * with update access to a session shared with them legitimately creates artifacts stamped with the
 * owner's `sessionId` (the artifact-persistence paths write the active session's id); an owner-only
 * check would wrongly 403 that flow, and a read-only sharee should not be able to reference the
 * session either. `canUpdateSession` therefore mirrors the session repo's update-access predicate
 * (owner OR update share OR group update share OR global-write share) - the same idiom used
 * elsewhere for writing into a shared object - and closes over the acting user.
 *
 * A quest carries no user of its own, so its access is transitive through the session it belongs
 * to (top-level `sessionId`): resolve the quest's session, then apply the same update-access check.
 *
 * Artifacts are NOT shareable (no cross-user artifact flow exists), so `parentArtifactId` stays a
 * strict owner check.
 */
export interface ArtifactRefAccessDeps {
  /** True iff the caller may write into the session (owner or update-shared with them). */
  canUpdateSession(sessionId: string): Promise<boolean>;
  /** The session a quest belongs to, or null if the quest does not exist. */
  getQuestSessionId(questId: string): Promise<string | null>;
  /** The owning userId of an artifact (by its custom `id`), or null if it does not exist. */
  getArtifactOwner(artifactId: string): Promise<string | null>;
}

/**
 * Reject caller-supplied provenance refs the caller is not entitled to reference. `artifactService.create`
 * (for every caller: route, agent persistence, notebook import) writes `sessionId` / `sourceQuestId` /
 * `parentArtifactId` onto the new artifact with the caller as owner, so each ref must point at a
 * session, quest, or artifact the caller can write to. Fails loud (403). Each ref is optional and
 * only checked when provided.
 */
export async function assertArtifactSourceRefsAccessible(
  userId: string,
  refs: ArtifactSourceRefs,
  deps: ArtifactRefAccessDeps
): Promise<void> {
  if (refs.sessionId && !(await deps.canUpdateSession(refs.sessionId))) {
    throw new ForbiddenError('You do not have access to the referenced session');
  }

  if (refs.sourceQuestId) {
    const questSessionId = await deps.getQuestSessionId(refs.sourceQuestId);
    if (!questSessionId || !(await deps.canUpdateSession(questSessionId))) {
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

import { questRepository, sessionRepository, artifactRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import {
  assertArtifactSourceRefsAccessible,
  type ArtifactSourceRefs,
} from '@server/utils/assertArtifactSourceRefsAccessible';

/**
 * Ref guard for a create made on behalf of `user`: session access is the session repo's update
 * predicate (owner, update/group-update share, or global-write share), quests resolve through
 * their session, and a parent artifact must be the actor's own.
 */
export function createArtifactSourceRefsGuard(user: IUserDocument) {
  return (userId: string, refs: ArtifactSourceRefs) =>
    assertArtifactSourceRefsAccessible(userId, refs, {
      canUpdateSession: async id =>
        !!(await sessionRepository.shareable.findUpdateAccessById(user, id, { includeGlobalWrite: true })),
      getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
      getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
    });
}

/**
 * Ref guard for the notebook import, where the session being referenced was created by the same
 * user inside the import's still-open transaction. Repository reads join that transaction through
 * its async-local session, so ownership is checked there rather than through a share lookup.
 */
export function createOwnedArtifactSourceRefsGuard() {
  return (userId: string, refs: ArtifactSourceRefs) =>
    assertArtifactSourceRefsAccessible(userId, refs, {
      canUpdateSession: async id => (await sessionRepository.findById(id))?.userId === userId,
      getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
      getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
    });
}

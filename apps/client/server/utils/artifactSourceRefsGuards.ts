import { artifactRepository, questRepository, sessionRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import type { artifactService } from '@bike4mind/services';
import { assertArtifactSourceRefsAccessible } from '@bike4mind/server-utils/utils/assertArtifactSourceRefsAccessible';
import { artifactSourceRefDeps } from '@server/artifacts/artifactAccess';

type ArtifactSourceRefsGuard = artifactService.ArtifactSourceRefsGuard;
type GuardUser = Parameters<typeof artifactSourceRefDeps>[0];

/**
 * Ref guard for a create made on behalf of `user`: session access is the session repo's update
 * predicate (owner, update/group-update share, or global-write share), quests resolve through
 * their session, and a parent artifact must be the actor's own.
 */
export function createArtifactSourceRefsGuard(user: GuardUser): ArtifactSourceRefsGuard {
  const deps = artifactSourceRefDeps(user);
  return (userId, refs) => assertArtifactSourceRefsAccessible(userId, refs, deps);
}

/**
 * Ref guard for the notebook import, where the session being referenced was created by the same
 * user inside the import's still-open transaction. Repository reads join that transaction through
 * its async-local session, so ownership is checked there rather than through a share lookup.
 */
export function createOwnedArtifactSourceRefsGuard(): ArtifactSourceRefsGuard {
  return (userId, refs) =>
    assertArtifactSourceRefsAccessible(userId, refs, {
      canUpdateSession: async id => (await sessionRepository.findById(id))?.userId === userId,
      getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
      getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
    });
}

/**
 * Guard for a run that creates many artifacts: the acting user is loaded on the first call only
 * (concurrent calls share the load), and a failed load is not cached so a later call retries.
 * A call for a different userId than the one loaded is refused rather than judged against the wrong user.
 */
export function createLazyArtifactSourceRefsGuard(
  loadUser: (userId: string) => Promise<IUserDocument | null | undefined>
): ArtifactSourceRefsGuard {
  let guardPromise: Promise<ArtifactSourceRefsGuard> | undefined;
  let guardUserId: string | undefined;

  const getGuard = (userId: string): Promise<ArtifactSourceRefsGuard> => {
    if (guardPromise) {
      if (guardUserId !== userId) {
        return Promise.reject(new Error('Cannot persist artifact: guard is bound to a different user'));
      }
      return guardPromise;
    }
    guardUserId = userId;
    const pending = (async () => {
      const user = await loadUser(userId);
      if (!user) throw new Error('Cannot persist artifact: user not found');
      return createArtifactSourceRefsGuard(user);
    })();
    guardPromise = pending;
    pending.catch(() => {
      if (guardPromise === pending) {
        guardPromise = undefined;
        guardUserId = undefined;
      }
    });
    return pending;
  };

  return async (userId, refs) => (await getGuard(userId))(userId, refs);
}

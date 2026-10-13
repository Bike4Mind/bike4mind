import { questRepository, sessionRepository, artifactRepository } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import {
  assertArtifactSourceRefsAccessible,
  type ArtifactRefAccessDeps,
  type ArtifactSourceRefs,
} from '@server/utils/assertArtifactSourceRefsAccessible';

type ArtifactSourceRefsGuard = (userId: string, refs: ArtifactSourceRefs) => Promise<void>;

/** Quest and parent-artifact lookups are the same for every guard; only session access differs. */
function buildRefAccessDeps(canUpdateSession: (sessionId: string) => Promise<boolean>): ArtifactRefAccessDeps {
  return {
    canUpdateSession,
    getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
    getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
  };
}

/**
 * Ref guard for a create made on behalf of `user`: session access is the session repo's update
 * predicate (owner, update/group-update share, or global-write share), quests resolve through
 * their session, and a parent artifact must be the actor's own.
 */
export function createArtifactSourceRefsGuard(user: IUserDocument): ArtifactSourceRefsGuard {
  const deps = buildRefAccessDeps(
    async id => !!(await sessionRepository.shareable.findUpdateAccessById(user, id, { includeGlobalWrite: true }))
  );
  return (userId, refs) => assertArtifactSourceRefsAccessible(userId, refs, deps);
}

/**
 * Ref guard for the notebook import, where the session being referenced was created by the same
 * user inside the import's still-open transaction. Repository reads join that transaction through
 * its async-local session, so ownership is checked there rather than through a share lookup.
 */
export function createOwnedArtifactSourceRefsGuard(): ArtifactSourceRefsGuard {
  return (userId, refs) =>
    assertArtifactSourceRefsAccessible(
      userId,
      refs,
      buildRefAccessDeps(async id => (await sessionRepository.findById(id))?.userId === userId)
    );
}

/**
 * Guard for a run that creates many artifacts: the acting user is loaded on the first call only
 * (concurrent calls share the load), and a failed load is not cached so a later call retries.
 */
export function createLazyArtifactSourceRefsGuard(
  loadUser: (userId: string) => Promise<IUserDocument | null | undefined>
): ArtifactSourceRefsGuard {
  let guardPromise: Promise<ArtifactSourceRefsGuard> | undefined;

  const getGuard = (userId: string): Promise<ArtifactSourceRefsGuard> => {
    if (guardPromise) return guardPromise;
    const pending = (async () => {
      const user = await loadUser(userId);
      if (!user) throw new Error('Cannot persist artifact: user not found');
      return createArtifactSourceRefsGuard(user);
    })();
    guardPromise = pending;
    pending.catch(() => {
      if (guardPromise === pending) guardPromise = undefined;
    });
    return pending;
  };

  return async (userId, refs) => (await getGuard(userId))(userId, refs);
}

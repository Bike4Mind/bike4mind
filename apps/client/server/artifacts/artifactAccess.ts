import {
  artifactContentRepository,
  artifactRepository,
  artifactVersionRepository,
  questRepository,
  sessionRepository,
} from '@bike4mind/database';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';
import type { ArtifactRefAccessDeps } from '@server/utils/assertArtifactSourceRefsAccessible';

// any: the database repositories do not structurally satisfy the services' repository interfaces;
// the SPA artifact routes cast the same way.
export const ARTIFACT_DB = {
  artifacts: artifactRepository as any,
  artifactContents: artifactContentRepository as any,
  artifactVersions: artifactVersionRepository as any,
};

/**
 * The lookups assertArtifactSourceRefsAccessible needs, shared by POST /api/artifacts and
 * POST /api/v1/artifacts so the two doors cannot drift. The session arm includes global-write shares:
 * such a sharee may write into the session graph, matching the CASL update ability.
 */
export function artifactSourceRefDeps(
  user: Parameters<typeof sessionRepository.shareable.findUpdateAccessById>[0]
): ArtifactRefAccessDeps {
  return {
    canUpdateSession: async id =>
      !!(await sessionRepository.shareable.findUpdateAccessById(user, id, { includeGlobalWrite: true })),
    getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
    getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
  };
}

/**
 * artifactService answers a denied read, write or delete with UnauthorizedError, which the SPA routes
 * serve as 401. The public routes serve it as the same 404 as a missing artifact, so ids cannot be
 * probed (CONVENTIONS.md status table).
 */
export async function hideArtifactDenial<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw new NotFoundError('Artifact not found');
    throw err;
  }
}

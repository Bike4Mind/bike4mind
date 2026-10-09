import { artifactContentRepository, artifactRepository, artifactVersionRepository } from '@bike4mind/database';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';

// any: the database repositories do not structurally satisfy the services' repository interfaces;
// the SPA artifact routes cast the same way.
export const ARTIFACT_DB = {
  artifacts: artifactRepository as any,
  artifactContents: artifactContentRepository as any,
  artifactVersions: artifactVersionRepository as any,
};

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

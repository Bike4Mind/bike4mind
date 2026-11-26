import type { IArtifactDocument, IArtifactVersionDocument } from '@bike4mind/common';
import { artifactContentRepository } from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';

/** A save that lost the pointer race: its row exists, but the artifact points at a higher version. */
export function isSupersededSave(
  artifact: Pick<IArtifactDocument, 'version'>,
  version?: Pick<IArtifactVersionDocument, 'version'>
) {
  return version !== undefined && version.version !== artifact.version;
}

/**
 * Content of the row the artifact points at, read by version number (a higher in-flight row may exist,
 * so not the latest). Null for a caller who fails the read rule, as for a write-only sharee.
 */
export async function readPointedContent(userId: string, artifact: IArtifactDocument): Promise<string | null> {
  if (!artifactService.canUserReadArtifact(userId, artifact)) return null;
  return (await artifactContentRepository.findByArtifactVersion(artifact.id, artifact.version))?.content ?? null;
}

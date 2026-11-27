import type { IArtifactDocument, IArtifactVersionDocument } from '@bike4mind/common';
import { artifactContentRepository, artifactVersionRepository } from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';

/** A save that lost the pointer race: its row exists, but the artifact points at a higher version. */
export function isSupersededSave(
  artifact: Pick<IArtifactDocument, 'version'>,
  version?: Pick<IArtifactVersionDocument, 'version'>
) {
  return version !== undefined && version.version !== artifact.version;
}

/** Content bound to the returned pointer snapshot; never a newer in-flight row. */
export async function readPointedContent(userId: string, artifact: IArtifactDocument): Promise<string | null> {
  if (!artifactService.canUserReadArtifact(userId, artifact)) return null;
  if (!artifact.currentVersionId) {
    return (await artifactContentRepository.findByArtifactVersion(artifact.id, artifact.version))?.content ?? null;
  }
  const version = await artifactVersionRepository.findOne({
    _id: artifact.currentVersionId,
    artifactId: artifact.id,
    version: artifact.version,
  });
  if (!version) return null;
  const content = await artifactContentRepository.findOne({
    _id: version.contentId,
    artifactId: artifact.id,
    version: artifact.version,
  });
  return content?.content ?? null;
}

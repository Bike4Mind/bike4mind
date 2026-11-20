import type { PublishedArtifactResource } from '@bike4mind/common';
import { artifactService } from '@bike4mind/services';
import { ARTIFACT_DB, hideArtifactDenial } from '@bike4mind/server-utils/artifacts/artifactAccess';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { absolutePublishUrl, type PublishedPage } from '@server/services/publish/publishStoredArtifact';

/**
 * Loads the artifact a v1 publish call acts on. Only the owner may publish: a sharee, a public
 * reader, a deleted artifact and a missing one all answer the same 404, so ids cannot be probed.
 */
export async function loadArtifactForPublish(userId: string, id: string) {
  const result = await hideArtifactDenial(
    artifactService.get(userId, { id, includeContent: true, includeVersions: false }, { db: ARTIFACT_DB })
  );
  if (result.access !== 'owner') throw new NotFoundError('Artifact not found');
  const content = result.content?.content;
  if (!content) throw new UnprocessableEntityError('The artifact has no content to publish');
  return {
    artifact: {
      id: result.artifact.id,
      type: result.artifact.type,
      title: result.artifact.title,
      version: result.artifact.version ?? 1,
    },
    content,
  };
}

export function toPublishedArtifactResource(artifactId: string, page: PublishedPage): PublishedArtifactResource {
  return {
    artifact_id: artifactId,
    public_id: page.publicId,
    url: absolutePublishUrl(page.path),
    slug: page.slug,
    visibility: page.visibility as PublishedArtifactResource['visibility'],
    access_gate: page.accessGateKind ? { kind: page.accessGateKind } : null,
    published_version: page.publishedVersion,
    published_at: page.publishedAt.toISOString(),
  };
}

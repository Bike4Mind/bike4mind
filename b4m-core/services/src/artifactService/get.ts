import { IArtifactRepository, IArtifactContentRepository, IArtifactVersionRepository } from '@bike4mind/common';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const getArtifactSchema = z.object({
  id: z.string(),
  includeContent: z.boolean().prefault(false),
  includeVersions: z.boolean().prefault(false),
  version: z.number().optional(),
});

type GetArtifactParameters = z.infer<typeof getArtifactSchema>;

interface GetArtifactAdapters {
  db: {
    artifacts: IArtifactRepository;
    artifactContents: IArtifactContentRepository;
    artifactVersions: IArtifactVersionRepository;
  };
}

/**
 * Retrieves an artifact with optional content and version information
 */
export const get = async (userId: string, parameters: GetArtifactParameters, adapters: GetArtifactAdapters) => {
  const { db } = adapters;
  const { id, includeContent, includeVersions, version } = secureParameters(parameters, getArtifactSchema);

  // Find the artifact by custom id field (supports legacy string IDs)
  const artifact = await db.artifacts.findOne({ id });
  if (!artifact) {
    throw new NotFoundError('Artifact not found');
  }

  // Check if artifact is deleted
  if (artifact.deletedAt) {
    throw new NotFoundError('Artifact not found');
  }

  // Check access permissions
  if (!canUserAccessArtifact(userId, artifact, 'read')) {
    throw new UnauthorizedError('Access denied');
  }

  const result: any = { artifact };

  // Include content if requested
  if (includeContent) {
    let content;
    if (version) {
      content = await db.artifactContents.findByArtifactVersion(artifact.id, version);
    } else {
      // Get latest content version
      content = await db.artifactContents.findLatestContent(artifact.id);
    }
    result.content = content;
  }

  // Include version history if requested
  if (includeVersions) {
    const versions = await db.artifactVersions.findByArtifactId(artifact.id);
    result.versions = versions;
  }

  return result;
};

/**
 * Check if user can access artifact based on permissions and visibility
 */
function canUserAccessArtifact(userId: string, artifact: any, accessType: 'read' | 'write' | 'delete'): boolean {
  // Owner always has access
  if (artifact.userId === userId) {
    return true;
  }

  // Check if public
  if (artifact.visibility === 'public' || artifact.permissions?.isPublic) {
    return accessType === 'read'; // Public artifacts are read-only for non-owners
  }

  // Check explicit permissions
  const permissionField = `can${accessType.charAt(0).toUpperCase() + accessType.slice(1)}`;
  if (artifact.permissions?.[permissionField]?.includes(userId)) {
    return true;
  }

  return false;
}

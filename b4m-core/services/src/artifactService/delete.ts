import { IArtifactRepository } from '@bike4mind/common';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const deleteArtifactSchema = z.object({
  id: z.string(),
  hardDelete: z.boolean().prefault(false), // For future implementation
});

type DeleteArtifactParameters = z.infer<typeof deleteArtifactSchema>;

interface DeleteArtifactAdapters {
  db: {
    artifacts: IArtifactRepository;
  };
}

/**
 * Soft deletes an artifact (marks as deleted but keeps in database)
 */
export const deleteArtifact = async (
  userId: string,
  parameters: DeleteArtifactParameters,
  adapters: DeleteArtifactAdapters
) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, deleteArtifactSchema);

  // Find the artifact by custom id field (supports legacy string IDs)
  const artifact = await db.artifacts.findOne({ id });
  if (!artifact) {
    throw new NotFoundError('Artifact not found');
  }

  // Check if already deleted
  if (artifact.deletedAt) {
    throw new NotFoundError('Artifact not found');
  }

  // Check delete permissions
  if (!canUserDeleteArtifact(userId, artifact)) {
    throw new UnauthorizedError('Delete access denied');
  }

  // Perform soft delete
  const updateData = {
    id: artifact.id,
    deletedAt: new Date(),
    status: 'deleted',
    updatedAt: new Date(),
  };

  await db.artifacts.update(updateData as any);

  return {
    success: true,
    message: 'Artifact deleted successfully',
  };
};

/**
 * Check if user can delete artifact
 */
function canUserDeleteArtifact(userId: string, artifact: any): boolean {
  // Owner always has delete access
  if (artifact.userId === userId) {
    return true;
  }

  // Check explicit delete permissions
  if (artifact.permissions?.canDelete?.includes(userId)) {
    return true;
  }

  return false;
}

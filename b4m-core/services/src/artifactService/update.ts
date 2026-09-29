import {
  IArtifactRepository,
  IArtifactContentRepository,
  IArtifactVersionRepository,
  calculateContentHash,
  calculateContentSize,
} from '@bike4mind/common';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const updateArtifactSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  content: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  versionTag: z.string().max(100).optional(),
  permissions: z
    .object({
      canRead: z.array(z.string()).optional(),
      canWrite: z.array(z.string()).optional(),
      canDelete: z.array(z.string()).optional(),
      isPublic: z.boolean().optional(),
      inheritFromProject: z.boolean().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  changes: z.array(z.string()).optional(),
  changeDescription: z.string().max(1000).optional(),
  createNewVersion: z.boolean().optional(),
  versionMessage: z.string().max(500).optional(),
});

type UpdateArtifactParameters = z.infer<typeof updateArtifactSchema>;

interface UpdateArtifactAdapters {
  db: {
    artifacts: IArtifactRepository;
    artifactContents: IArtifactContentRepository;
    artifactVersions: IArtifactVersionRepository;
  };
}

/**
 * Updates an artifact and creates a new version if content changed
 */
export const update = async (
  userId: string,
  parameters: UpdateArtifactParameters,
  adapters: UpdateArtifactAdapters
) => {
  const { db } = adapters;
  const {
    id,
    title,
    description,
    content,
    visibility,
    status,
    tags,
    versionTag,
    permissions,
    metadata,
    changes,
    changeDescription,
    createNewVersion,
    versionMessage,
  } = secureParameters(parameters, updateArtifactSchema);

  // Find the artifact by custom id field (supports legacy string IDs)
  const artifact = await db.artifacts.findOne({ id });
  if (!artifact) {
    throw new NotFoundError('Artifact not found');
  }

  // Check if artifact is deleted
  if (artifact.deletedAt) {
    throw new NotFoundError('Artifact not found');
  }

  // Check write permissions
  if (!canUserWriteArtifact(userId, artifact)) {
    throw new UnauthorizedError('Write access denied');
  }

  // Permissions and visibility are owner-only. A non-owner writer may edit
  // content/title/description/tags, but must not be able to change sharing or
  // visibility (which would let them self-escalate or lock out the owner).
  if ((permissions !== undefined || visibility !== undefined) && artifact.userId !== userId) {
    throw new UnauthorizedError('Only the owner can change permissions or visibility');
  }

  // Prepare update data
  const updateData: any = {
    id: artifact.id,
    updatedAt: new Date(),
  };

  // Update metadata fields
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (visibility !== undefined) updateData.visibility = visibility;
  if (status !== undefined) updateData.status = status;
  if (tags !== undefined) updateData.tags = tags;
  if (versionTag !== undefined) updateData.versionTag = versionTag;
  if (metadata !== undefined) updateData.metadata = { ...artifact.metadata, ...metadata };

  // Handle permissions update
  if (permissions !== undefined) {
    updateData.permissions = {
      ...artifact.permissions,
      ...permissions,
    };
  }

  // Gated claim before any version or content row is written: a writer revoked (or an artifact
  // deleted) since the check above is refused here and leaves nothing behind.
  const claimed = await db.artifacts.updateWithWriteAccess(userId, updateData);
  if (!claimed) {
    throw new UnauthorizedError('Write access denied');
  }

  let newVersion = null;
  let newContent = null;
  let deactivatedVersionId: string | null = null;
  // Written only after the version and content rows exist, through the same gate.
  const pointer: Record<string, unknown> = {};

  // Handle content update (creates new version)
  if (content !== undefined) {
    const contentHash = calculateContentHash(content);
    const contentSize = calculateContentSize(content);

    // Check if content actually changed OR if forced version creation is requested
    if (contentHash !== artifact.contentHash || createNewVersion) {
      // Get the highest version number from the database
      const allVersions = await db.artifactVersions.findByArtifactId(artifact.id);

      // Calculate highest version from both artifactVersions collection and artifact.version field
      const versionsFromCollection = allVersions.reduce((max, v) => {
        const versionNum = v.version || 0;
        return versionNum > max ? versionNum : max;
      }, 0);

      const artifactVersion = artifact.version || 0;

      const highestVersion = Math.max(versionsFromCollection, artifactVersion);
      const newVersionNumber = highestVersion + 1;

      // Create or update content record
      newContent = await db.artifactContents.createOrUpdate({
        artifactId: artifact.id,
        version: newVersionNumber,
        content,
        contentHash,
        contentSize,
        mimeType: getMimeTypeFromArtifact(artifact),
        encoding: 'utf8',
      });

      // Deactivate current version
      if (artifact.currentVersionId) {
        // Use findOne to avoid ObjectId casting issues
        const currentVersionDoc = await db.artifactVersions.findOne({ _id: artifact.currentVersionId } as any);
        if (currentVersionDoc) {
          await db.artifactVersions.update({
            id: currentVersionDoc._id,
            isActive: false,
          } as any);
          deactivatedVersionId = currentVersionDoc._id;
        }
      }

      // Create or update version record
      newVersion = await db.artifactVersions.createOrUpdate({
        artifactId: artifact.id,
        version: newVersionNumber,
        contentId: newContent?._id,
        parentVersionId: artifact.currentVersionId,
        changes: changes || ['Content updated'],
        changeDescription: changeDescription || versionMessage || 'Updated artifact content',
        createdBy: userId,
        isActive: true,
      });

      // Update artifact with new version info
      pointer.version = newVersionNumber;
      pointer.currentVersionId = newVersion._id;
      pointer.contentHash = contentHash;
      pointer.contentSize = contentSize;
    }
  } else if (createNewVersion) {
    // Handle case where we want to create a new version without content changes
    // Get the highest version number from the database
    const allVersions = await db.artifactVersions.findByArtifactId(artifact.id);

    // Calculate highest version from both artifactVersions collection and artifact.version field
    const versionsFromCollection = allVersions.reduce((max, v) => {
      const versionNum = v.version || 0;
      return versionNum > max ? versionNum : max;
    }, 0);

    const artifactVersion = artifact.version || 0;

    const highestVersion = Math.max(versionsFromCollection, artifactVersion);
    const newVersionNumber = highestVersion + 1;

    // Get the current content
    const currentContentArray = await db.artifactContents.findByArtifactId(artifact.id);
    const currentContent = currentContentArray?.[0]; // Get the latest content
    if (currentContent) {
      // Create or update content record with same content
      newContent = await db.artifactContents.createOrUpdate({
        artifactId: artifact.id,
        version: newVersionNumber,
        content: currentContent.content,
        contentHash: currentContent.contentHash,
        contentSize: currentContent.contentSize,
        mimeType: currentContent.mimeType,
        encoding: currentContent.encoding,
      });

      // Deactivate current version
      if (artifact.currentVersionId) {
        // Use findOne to avoid ObjectId casting issues
        const currentVersionDoc = await db.artifactVersions.findOne({ _id: artifact.currentVersionId } as any);
        if (currentVersionDoc) {
          await db.artifactVersions.update({
            id: currentVersionDoc._id,
            isActive: false,
          } as any);
          deactivatedVersionId = currentVersionDoc._id;
        }
      }

      // Create or update version record
      newVersion = await db.artifactVersions.createOrUpdate({
        artifactId: artifact.id,
        version: newVersionNumber,
        contentId: newContent._id,
        parentVersionId: artifact.currentVersionId,
        changes: changes || ['Version created'],
        changeDescription: changeDescription || versionMessage || 'Created new version',
        createdBy: userId,
        isActive: true,
      });

      // Update artifact with new version info
      pointer.version = newVersionNumber;
      pointer.currentVersionId = newVersion._id;
    }
  }

  let updatedArtifact = claimed;
  if (newVersion) {
    const pointed = await db.artifacts.updateWithWriteAccess(userId, { id: artifact.id, ...pointer });
    if (!pointed) {
      // Revoked in the few ms since the claim. Undo this save's rows: left in place, the new version
      // would be served by the versions routes and returned as the active one while the artifact
      // still points at the previous. Best-effort, not transactional.
      await db.artifactVersions.delete(String(newVersion._id));
      if (newContent) await db.artifactContents.delete(String(newContent._id));
      if (deactivatedVersionId) {
        await db.artifactVersions.update({ id: deactivatedVersionId, isActive: true } as any);
      }
      throw new UnauthorizedError('Write access denied');
    }
    updatedArtifact = pointed;
  }

  const result: any = {
    artifact: updatedArtifact,
  };

  if (newContent) result.content = newContent;
  if (newVersion) result.version = newVersion;

  return result;
};

/**
 * Check if user can write to artifact. Must stay in sync with ArtifactRepository.updateWithWriteAccess.
 */
function canUserWriteArtifact(userId: string, artifact: any): boolean {
  // Owner always has write access
  if (artifact.userId === userId) {
    return true;
  }

  // Check explicit write permissions
  if (artifact.permissions?.canWrite?.includes(userId)) {
    return true;
  }

  return false;
}

/**
 * Get MIME type from existing artifact
 */
function getMimeTypeFromArtifact(artifact: any): string {
  const mimeTypeMap: Record<string, string> = {
    react: 'text/javascript',
    html: 'text/html',
    svg: 'image/svg+xml',
    mermaid: 'text/plain',
    python: 'text/x-python',
    code: 'text/plain',
    questmaster: 'application/json',
    quest: 'application/json',
    file: 'application/octet-stream',
  };

  return mimeTypeMap[artifact.type] || 'text/plain';
}

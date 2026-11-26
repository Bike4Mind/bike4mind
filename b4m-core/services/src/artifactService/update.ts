import {
  IArtifactDocument,
  IArtifactContentDocument,
  IArtifactVersionDocument,
  IArtifactRepository,
  IArtifactContentRepository,
  IArtifactVersionRepository,
  calculateContentHash,
  calculateContentSize,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';
import type { CreateInput } from './create';

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
    artifacts: Pick<
      IArtifactRepository,
      'findOne' | 'updateWithWriteAccess' | 'claimNextVersionNumber' | 'seedVersionCounter'
    >;
    artifactContents: Pick<IArtifactContentRepository, 'create' | 'delete' | 'findLatestContent'>;
    artifactVersions: Pick<
      IArtifactVersionRepository,
      'create' | 'delete' | 'findByArtifactId' | 'activatePointerVersion'
    >;
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
  if (metadata !== undefined) updateData.metadata = { ...artifact.metadata, ...metadata };

  // Handle permissions update
  if (permissions !== undefined) {
    updateData.permissions = {
      ...artifact.permissions,
      ...permissions,
    };
  }

  let newVersion: IArtifactVersionDocument | undefined;
  let newContent: IArtifactContentDocument | undefined;
  let versionNumber = 0;
  // Version pointer fields; written only when the save beat every higher version to the pointer.
  const versionUpdate: Record<string, unknown> = {};

  // Allocates atomically under the write-access filter so a writer revoked since the check above is refused
  // before any row is written; metadata waits for the final gated write so a failed save never half-applies it.
  const allocateVersionNumber = async () => {
    let claimed = await db.artifacts.claimNextVersionNumber(userId, artifact.id);
    if (claimed === null) {
      // Counter not seeded yet (artifact predates it): seed from the highest existing number, then claim again.
      const allVersions = await db.artifactVersions.findByArtifactId(artifact.id);
      const seed = allVersions.reduce((max, v) => Math.max(max, v.version || 0), artifact.version || 0);
      await db.artifacts.seedVersionCounter(userId, artifact.id, seed);
      claimed = await db.artifacts.claimNextVersionNumber(userId, artifact.id);
    }
    if (claimed === null) {
      throw new UnauthorizedError('Write access denied');
    }
    return claimed;
  };

  // Inserts the content and version rows for `versionNumber`; the row stays inactive until the pointer picks it.
  const writeVersionRows = async (
    versionNumber: number,
    contentFields: Pick<IArtifactContentDocument, 'content' | 'contentHash' | 'contentSize' | 'mimeType' | 'encoding'>,
    defaults: { changes: string[]; changeDescription: string }
  ) => {
    const newContent = await db.artifactContents.create({
      artifactId: artifact.id,
      version: versionNumber,
      ...contentFields,
    } satisfies CreateInput<IArtifactContentDocument> as Parameters<IArtifactContentRepository['create']>[0]);

    const newVersion = await db.artifactVersions.create({
      artifactId: artifact.id,
      version: versionNumber,
      contentId: newContent._id,
      parentVersionId: artifact.currentVersionId,
      changes: changes || defaults.changes,
      changeDescription: changeDescription || versionMessage || defaults.changeDescription,
      ...(versionTag !== undefined && { versionTag }),
      createdBy: userId,
      isActive: false,
    } satisfies CreateInput<IArtifactVersionDocument> as Parameters<IArtifactVersionRepository['create']>[0]);

    return { newContent, newVersion };
  };

  // Handle content update (creates new version)
  if (content !== undefined) {
    const contentHash = calculateContentHash(content);
    const contentSize = calculateContentSize(content);

    // Check if content actually changed OR if forced version creation is requested
    if (contentHash !== artifact.contentHash || createNewVersion) {
      versionNumber = await allocateVersionNumber();
      ({ newContent, newVersion } = await writeVersionRows(
        versionNumber,
        { content, contentHash, contentSize, mimeType: getMimeTypeFromArtifact(artifact), encoding: 'utf8' },
        { changes: ['Content updated'], changeDescription: 'Updated artifact content' }
      ));
      versionUpdate.contentHash = contentHash;
      versionUpdate.contentSize = contentSize;
    }
  } else if (createNewVersion) {
    // Handle case where we want to create a new version without content changes
    const currentContent = await db.artifactContents.findLatestContent(artifact.id);
    if (currentContent) {
      versionNumber = await allocateVersionNumber();
      ({ newContent, newVersion } = await writeVersionRows(
        versionNumber,
        {
          content: currentContent.content,
          contentHash: currentContent.contentHash,
          contentSize: currentContent.contentSize,
          mimeType: currentContent.mimeType,
          encoding: currentContent.encoding,
        },
        { changes: ['Version created'], changeDescription: 'Created new version' }
      ));
    }
  }

  if (newVersion) {
    versionUpdate.version = versionNumber;
    versionUpdate.currentVersionId = newVersion._id;
  }
  // An explicit new version without a tag must not inherit the previous version's tag on the artifact.
  if (versionTag !== undefined) (newVersion ? versionUpdate : updateData).versionTag = versionTag;
  else if (newVersion && createNewVersion) versionUpdate.versionTag = null;

  // One gated write for metadata and the version pointer together. The pointer only moves forward:
  // a save that lost the race to a higher version keeps its row inactive and leaves the pointer alone.
  const pointerWrite = await db.artifacts.updateWithWriteAccess(
    userId,
    { ...updateData, ...versionUpdate },
    newVersion ? { version: { $lt: versionNumber } } : undefined
  );
  let updatedArtifact = pointerWrite;
  if (!updatedArtifact && newVersion) {
    updatedArtifact = await db.artifacts.updateWithWriteAccess(userId, updateData);
  }
  if (!updatedArtifact) {
    if (newVersion) await rollbackVersionRows(adapters, artifact.id, newVersion._id, newContent?._id);
    throw new UnauthorizedError('Write access denied');
  }

  if (newVersion && pointerWrite) {
    newVersion.isActive =
      (await reconcileActiveVersion(adapters, artifact.id, {
        id: String(pointerWrite.currentVersionId),
        version: pointerWrite.version,
      })) === String(newVersion._id);
  }

  const result: {
    artifact: IArtifactDocument;
    content?: IArtifactContentDocument;
    version?: IArtifactVersionDocument;
  } = {
    artifact: updatedArtifact,
  };

  if (newContent) result.content = newContent;
  if (newVersion) result.version = newVersion;

  return result;
};

/** Deletes a refused save's version and content rows. Best-effort, not transactional; each step is independent. */
async function rollbackVersionRows(
  { db }: UpdateArtifactAdapters,
  artifactId: string,
  versionId: string,
  contentId: string | undefined
) {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      Logger.globalInstance.error(`artifact update rollback: ${label} failed for artifact ${artifactId}:`, error);
    }
  };

  await step('delete version', () => db.artifactVersions.delete(String(versionId)));
  if (contentId) await step('delete content', () => db.artifactContents.delete(String(contentId)));
}

const MAX_RECONCILE_ATTEMPTS = 5;

/** Makes the row the artifact pointer names the only active one and returns its id; undefined when it did not settle. Never throws. */
async function reconcileActiveVersion(
  { db }: UpdateArtifactAdapters,
  artifactId: string,
  initialPointer: { id: string; version: number }
): Promise<string | undefined> {
  try {
    let pointer = initialPointer;
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      await db.artifactVersions.activatePointerVersion(artifactId, pointer);
      const latest = await db.artifacts.findOne({ id: artifactId });
      if (!latest?.currentVersionId) return undefined;
      if (String(latest.currentVersionId) === pointer.id && latest.version === pointer.version) return pointer.id;
      pointer = { id: String(latest.currentVersionId), version: latest.version };
    }
    Logger.globalInstance.warn(`artifact update: active version of artifact ${artifactId} did not settle`);
  } catch (error) {
    Logger.globalInstance.error(
      `artifact update: reconciling active version failed for artifact ${artifactId}:`,
      error
    );
  }
  return undefined;
}

/**
 * Check if user can write to artifact. Must stay in sync with ArtifactRepository.writeAccessFilter.
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

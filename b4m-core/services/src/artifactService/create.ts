import {
  IArtifactRepository,
  IArtifactContentRepository,
  IArtifactVersionRepository,
  createArtifactId,
  calculateContentHash,
  calculateContentSize,
  createDefaultPermissions,
  ArtifactTypeSchema,
  ArtifactType,
  getArtifactMimeType,
} from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const createArtifactSchema = z.object({
  id: z.string().optional(), // Allow custom ID for AI-generated artifacts
  type: ArtifactTypeSchema,
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  content: z.string().min(1),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).prefault('private'),
  tags: z.array(z.string().max(50)).max(20).prefault([]),
  versionTag: z.string().max(100).optional(),
  sourceQuestId: z.string().optional(),
  sessionId: z.string().optional(),
  parentArtifactId: z.string().optional(),
  permissions: z
    .object({
      canRead: z.array(z.string()).prefault([]),
      canWrite: z.array(z.string()).prefault([]),
      canDelete: z.array(z.string()).prefault([]),
      isPublic: z.boolean().prefault(false),
      inheritFromProject: z.boolean().prefault(true),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
});

type CreateArtifactParameters = z.infer<typeof createArtifactSchema>;

interface CreateArtifactAdapters {
  db: {
    artifacts: IArtifactRepository;
    artifactContents: IArtifactContentRepository;
    artifactVersions: IArtifactVersionRepository;
  };
}

/**
 * Creates a new artifact with content and initial version
 */
export const create = async (
  userId: string,
  parameters: CreateArtifactParameters,
  adapters: CreateArtifactAdapters
) => {
  const { db } = adapters;
  const {
    id: providedId,
    type,
    title,
    description,
    content,
    projectId,
    organizationId,
    visibility,
    tags,
    versionTag,
    sourceQuestId,
    sessionId,
    parentArtifactId,
    permissions,
    metadata,
  } = secureParameters(parameters, createArtifactSchema);

  // Use provided ID if available (for AI-generated artifacts), otherwise generate one
  const artifactId = providedId || createArtifactId();

  // Calculate content metadata
  const contentHash = calculateContentHash(content);
  const contentSize = calculateContentSize(content);

  // Create content record first
  const artifactContent = await db.artifactContents.create({
    artifactId,
    version: 1,
    content,
    contentHash,
    contentSize,
    mimeType: getContentMimeType(type),
    encoding: 'utf8',
  } as any);

  // Create version record
  const artifactVersion = await db.artifactVersions.create({
    artifactId,
    version: 1,
    contentId: artifactContent._id,
    changes: ['Initial version'],
    changeDescription: 'Created artifact',
    createdBy: userId,
    isActive: true,
  } as any);

  // Set up permissions
  const artifactPermissions = permissions || createDefaultPermissions(userId);

  // Create main artifact record
  const artifact = {
    id: artifactId,
    type,
    title,
    description,
    version: 1,
    versionTag,
    currentVersionId: artifactVersion._id,
    contentId: artifactContent._id, // required contentId field
    userId,
    projectId,
    organizationId,
    visibility,
    permissions: artifactPermissions,
    sourceQuestId,
    sessionId,
    parentArtifactId,
    status: 'draft',
    tags,
    contentHash,
    contentSize,
    metadata,
  };

  const createdArtifact = await db.artifacts.create(artifact as any);

  return {
    artifact: createdArtifact,
    content: artifactContent,
    version: artifactVersion,
  };
};

/**
 * Determines MIME type based on artifact type
 * Uses centralized registry from @bike4mind/common
 */
function getContentMimeType(type: ArtifactType): string {
  return getArtifactMimeType(type);
}

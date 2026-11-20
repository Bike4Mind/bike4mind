import {
  IArtifactDocument,
  IArtifactContentDocument,
  IArtifactVersionDocument,
  IArtifactRepository,
  IArtifactContentRepository,
  IArtifactVersionRepository,
} from '@bike4mind/common';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';
import {
  toArtifactViewerView,
  toArtifactViewerVersion,
  type ArtifactViewerView,
  type ArtifactViewerVersion,
} from './toArtifactViewerView';

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
 * How the caller may read: `owner` and `shared` (an explicit grant) get the full document; `public`
 * (no grant, only the artifact's public flag) gets the viewer shape.
 */
export type ArtifactReadAccess = 'owner' | 'shared' | 'public';

type ArtifactContentResult = {
  content?: IArtifactContentDocument | null;
};

export type GetArtifactResult = ArtifactContentResult &
  (
    | {
        access: 'owner' | 'shared';
        artifact: IArtifactDocument;
        versions?: IArtifactVersionDocument[];
      }
    | {
        access: 'public';
        artifact: ArtifactViewerView;
        versions?: ArtifactViewerVersion<IArtifactVersionDocument>[];
      }
  );

/**
 * Retrieves an artifact with optional content and version information
 */
export const get = async (
  userId: string,
  parameters: GetArtifactParameters,
  adapters: GetArtifactAdapters
): Promise<GetArtifactResult> => {
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

  const access = readAccess(userId, artifact);
  if (!access) {
    throw new UnauthorizedError('Access denied');
  }

  const result: GetArtifactResult =
    access === 'public' ? { access, artifact: toArtifactViewerView(artifact) } : { access, artifact };

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
    if (result.access === 'public') {
      result.versions = versions.map(toArtifactViewerVersion);
    } else {
      result.versions = versions;
    }
  }

  return result;
};

/**
 * The read rule `get` enforces, for callers that hold an artifact without going through `get`.
 * Structural, so a full document or a field projection both satisfy it; `permissions` may be absent
 * (legacy rows and projections hand one in - see isPublicArtifact in `@bike4mind/common`).
 */
export function canUserReadArtifact(
  userId: string,
  artifact: {
    userId: string;
    visibility?: string;
    permissions?: { canRead?: string[]; isPublic?: boolean };
  }
): boolean {
  return readAccess(userId, artifact) !== null;
}

/** Why `userId` may read the artifact, or null. A write-only grant on a private artifact is not a read. */
function readAccess(
  userId: string,
  artifact: {
    userId: string;
    visibility?: string;
    permissions?: { canRead?: string[]; canWrite?: string[]; isPublic?: boolean };
  }
): ArtifactReadAccess | null {
  if (artifact.userId === userId) return 'owner';
  const granted = artifact.permissions?.canRead?.includes(userId) || artifact.permissions?.canWrite?.includes(userId);
  if (artifact.visibility === 'public' || artifact.permissions?.isPublic) return granted ? 'shared' : 'public';
  return artifact.permissions?.canRead?.includes(userId) ? 'shared' : null;
}

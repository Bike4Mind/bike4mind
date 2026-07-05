import { IArtifactRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listArtifactsSchema = z.object({
  type: z.string().optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  limit: z.number().min(1).max(100).prefault(20),
  offset: z.number().min(0).prefault(0),
  sortBy: z.enum(['createdAt', 'updatedAt', 'title', 'type']).prefault('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).prefault('desc'),
  includeDeleted: z.boolean().prefault(false),
});

type ListArtifactsParameters = z.infer<typeof listArtifactsSchema>;

interface ListArtifactsAdapters {
  db: {
    artifacts: IArtifactRepository;
  };
}

/**
 * Lists artifacts for a user with filtering and pagination
 */
export const list = async (userId: string, parameters: ListArtifactsParameters, adapters: ListArtifactsAdapters) => {
  const { db } = adapters;
  const {
    type,
    status,
    visibility,
    projectId,
    sessionId,
    tags,
    search,
    limit,
    offset,
    sortBy,
    sortOrder,
    includeDeleted,
  } = secureParameters(parameters, listArtifactsSchema);

  // Build filter object
  const filter: Record<string, any> = {
    userId,
  };

  // Add optional filters
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (visibility) filter.visibility = visibility;
  if (projectId) filter.projectId = projectId;
  if (sessionId) filter.sessionId = sessionId;
  if (tags && tags.length > 0) {
    filter.tags = { $in: tags };
  }

  // Handle deleted artifacts
  if (!includeDeleted) {
    filter.deletedAt = null;
  }

  // Get artifacts with filtering
  let artifacts;
  if (search) {
    artifacts = await db.artifacts.searchByText(search, filter);
  } else {
    artifacts = await db.artifacts.find(filter);
  }

  // Apply sorting
  artifacts.sort((a, b) => {
    const aValue = a[sortBy as keyof typeof a];
    const bValue = b[sortBy as keyof typeof b];

    // Handle undefined values
    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    if (sortOrder === 'asc') {
      return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
    } else {
      return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
    }
  });

  // Apply pagination
  const total = artifacts.length;
  const paginatedArtifacts = artifacts.slice(offset, offset + limit);

  return {
    artifacts: paginatedArtifacts,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  };
};

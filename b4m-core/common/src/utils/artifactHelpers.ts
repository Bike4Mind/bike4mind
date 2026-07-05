import { ArtifactStatuses } from '../schemas/artifacts';
import { BaseArtifact, ArtifactPermissions } from '../types/entities/ArtifactTypes';
import { createHash } from 'crypto';

// Type guards
export function isArtifact(obj: unknown): obj is BaseArtifact {
  return typeof obj === 'object' && obj !== null && 'id' in obj && 'type' in obj && 'title' in obj;
}

export function isPublicArtifact(artifact: BaseArtifact): boolean {
  return artifact.visibility === 'public' || artifact.permissions.isPublic;
}

export function isDraftArtifact(artifact: BaseArtifact): boolean {
  return artifact.status === ArtifactStatuses.DRAFT;
}

export function isPublishedArtifact(artifact: BaseArtifact): boolean {
  return artifact.status === ArtifactStatuses.PUBLISHED;
}

export function isDeletedArtifact(artifact: BaseArtifact): boolean {
  return artifact.status === ArtifactStatuses.DELETED || artifact.deletedAt !== undefined;
}

// Content helpers
export function calculateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function calculateContentSize(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

// Permission helpers
export function canUserReadArtifact(artifact: BaseArtifact, userId: string): boolean {
  if (isPublicArtifact(artifact)) return true;
  if (artifact.userId === userId) return true;
  if (artifact.permissions.canRead.includes(userId)) return true;
  return false;
}

export function canUserWriteArtifact(artifact: BaseArtifact, userId: string): boolean {
  if (artifact.userId === userId) return true;
  if (artifact.permissions.canWrite.includes(userId)) return true;
  return false;
}

export function canUserDeleteArtifact(artifact: BaseArtifact, userId: string): boolean {
  if (artifact.userId === userId) return true;
  if (artifact.permissions.canDelete.includes(userId)) return true;
  return false;
}

// Factory functions
export function createDefaultPermissions(userId: string): ArtifactPermissions {
  return {
    canRead: [userId],
    canWrite: [userId],
    canDelete: [userId],
    isPublic: false,
    inheritFromProject: true,
  };
}

export function createArtifactId(): string {
  // Timestamp + random suffix; not a collision-proof UUID.
  return `artifact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Validation helpers
export function validateArtifactTitle(title: string): { valid: boolean; error?: string } {
  if (!title || title.trim().length === 0) {
    return { valid: false, error: 'Title is required' };
  }
  if (title.length > 255) {
    return { valid: false, error: 'Title must be 255 characters or less' };
  }
  return { valid: true };
}

export function validateArtifactDescription(description?: string): { valid: boolean; error?: string } {
  if (!description) {
    return { valid: true }; // Description is optional
  }
  if (description.length > 1000) {
    return { valid: false, error: 'Description must be 1000 characters or less' };
  }
  return { valid: true };
}

export function validateArtifactTags(tags: string[]): { valid: boolean; error?: string } {
  if (tags.length > 20) {
    return { valid: false, error: 'Maximum 20 tags allowed' };
  }
  const invalidTag = tags.find(tag => tag.length > 50);
  if (invalidTag) {
    return { valid: false, error: 'Tags must be 50 characters or less' };
  }
  return { valid: true };
}

// Visibility helpers
export function getVisibilityLevel(visibility: BaseArtifact['visibility']): number {
  const levels = {
    private: 0,
    project: 1,
    organization: 2,
    public: 3,
  };
  return levels[visibility];
}

export function canAccessBasedOnVisibility(
  artifact: BaseArtifact,
  userId: string,
  userProjectId?: string,
  userOrganizationId?: string
): boolean {
  // Owner always has access
  if (artifact.userId === userId) return true;

  // Check visibility levels
  switch (artifact.visibility) {
    case 'public':
      return true;
    case 'organization':
      return artifact.organizationId === userOrganizationId;
    case 'project':
      return artifact.projectId === userProjectId;
    case 'private':
      return false;
    default:
      return false;
  }
}

// Status transition helpers
export function canTransitionStatus(currentStatus: ArtifactStatuses, newStatus: ArtifactStatuses): boolean {
  const validTransitions: Record<ArtifactStatuses, ArtifactStatuses[]> = {
    [ArtifactStatuses.DRAFT]: [ArtifactStatuses.REVIEW, ArtifactStatuses.PUBLISHED, ArtifactStatuses.DELETED],
    [ArtifactStatuses.REVIEW]: [ArtifactStatuses.DRAFT, ArtifactStatuses.PUBLISHED, ArtifactStatuses.DELETED],
    [ArtifactStatuses.PUBLISHED]: [ArtifactStatuses.ARCHIVED, ArtifactStatuses.DELETED],
    [ArtifactStatuses.ARCHIVED]: [ArtifactStatuses.PUBLISHED, ArtifactStatuses.DELETED],
    [ArtifactStatuses.DELETED]: [], // No transitions from deleted
  };

  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
}

// Metadata helpers
export function mergeArtifactMetadata<T extends Record<string, any>>(existing: T, updates: Partial<T>): T {
  return {
    ...existing,
    ...updates,
    ...(updates.dependencies && { dependencies: [...(updates.dependencies as any[])] }),
    ...(updates.settings && { settings: { ...existing.settings, ...updates.settings } }),
  };
}

// Search helpers
export function matchesSearchQuery(artifact: BaseArtifact, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  return (
    artifact.title.toLowerCase().includes(lowerQuery) ||
    artifact.description?.toLowerCase().includes(lowerQuery) ||
    artifact.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}

// Sorting helpers
export type ArtifactSortField = 'createdAt' | 'updatedAt' | 'title' | 'status';
export type SortOrder = 'asc' | 'desc';

export function sortArtifacts(
  artifacts: BaseArtifact[],
  field: ArtifactSortField = 'updatedAt',
  order: SortOrder = 'desc'
): BaseArtifact[] {
  return [...artifacts].sort((a, b) => {
    let aValue: any = a[field];
    let bValue: any = b[field];

    if (aValue instanceof Date) aValue = aValue.getTime();
    if (bValue instanceof Date) bValue = bValue.getTime();

    if (typeof aValue === 'string' && typeof bValue === 'string') {
      aValue = aValue.toLowerCase();
      bValue = bValue.toLowerCase();
    }

    if (order === 'asc') {
      return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
    } else {
      return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
    }
  });
}

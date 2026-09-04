import { ArtifactStatuses } from '../schemas/artifacts';
import { BaseArtifact, ArtifactPermissions } from '../types/entities/ArtifactTypes';
import { createHash } from 'crypto';

// Type guards
export function isArtifact(obj: unknown): obj is BaseArtifact {
  return typeof obj === 'object' && obj !== null && 'id' in obj && 'type' in obj && 'title' in obj;
}

export function isPublicArtifact(artifact: BaseArtifact): boolean {
  // `permissions` is `required: true` in the schema, so the gap is not new writes: a legacy row
  // and a field projection both hand this an artifact with `permissions` undefined. These run on
  // the ACCESS-CHECK path, so an unguarded dereference throws where the answer should be "no".
  // Must stay in sync with the isPublic virtual in packages/database ArtifactModel.
  return artifact.visibility === 'public' || artifact.permissions?.isPublic === true;
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
  if (artifact.permissions?.canRead?.includes(userId)) return true;
  return false;
}

export function canUserWriteArtifact(artifact: BaseArtifact, userId: string): boolean {
  if (artifact.userId === userId) return true;
  if (artifact.permissions?.canWrite?.includes(userId)) return true;
  return false;
}

export function canUserDeleteArtifact(artifact: BaseArtifact, userId: string): boolean {
  if (artifact.userId === userId) return true;
  if (artifact.permissions?.canDelete?.includes(userId)) return true;
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

/** Index of the identifier field in an `artifact_`-shaped id. */
const IDENTIFIER_SEGMENT = 2;

/**
 * Mints an artifact id in the shape the client parses:
 * `artifact_{type}_{identifier}_{timestamp}_{index}_{random}`.
 *
 * Each of the first five positions is read by name somewhere, so none of them can move:
 * `useArtifactVersions` (app/hooks/data/artifacts.ts) treats an id with fewer than five segments
 * as legacy and skips fetching version history; `getStableTimestamp` (KnowledgeViewer,
 * knowledgeViewerSorting) reads segment 3 as a number; and `findExistingArtifactId`
 * (app/utils/artifactPersistence.ts) compares segment 2 for equality against the identifier the
 * rendered card parsed out of the reply, which is how that card adopts this row instead of minting
 * an id of its own. `type` and `identifier` are stripped of `_` to keep the later positions honest.
 *
 * `id` is globally unique in the DB and the timestamp does not separate two artifacts minted in the
 * same millisecond, so the random tail does. It is a segment of its own rather than a suffix on an
 * existing one because every earlier position already has a reader that compares it whole.
 *
 * `apps/client/app/utils/artifactParser.ts` exports `generateCompleteArtifactId`, which mints the
 * same shape for artifacts parsed out of a reply. The two are a known fork - see
 * `persistAgentArtifacts.ts` for why they are not interchangeable - but the shape has to stay in
 * sync across both, and the identifier segment is the one the client compares.
 */
export function createArtifactId(type: string = 'generated', identifier?: string): string {
  const segment = (value: string, fallback: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback;

  const random = Math.random().toString(36).slice(2, 8);
  return `artifact_${segment(type, 'generated')}_${segment(identifier ?? '', 'artifact')}_${Date.now()}_0_${random}`;
}

/**
 * The identifier segment of an `artifact_`-shaped id, or undefined when `id` is not that shape.
 *
 * This is the field `findExistingArtifactId` matches on, so it is what has to survive when an id is
 * reminted for a copy of an existing artifact: the reply the copy is rendered from still carries the
 * original `<artifact identifier=...>` attribute, and that attribute is what this segment holds.
 */
export function getArtifactIdentifier(id: string): string | undefined {
  const segments = id.split('_');
  return id.startsWith('artifact_') && segments.length > IDENTIFIER_SEGMENT
    ? segments[IDENTIFIER_SEGMENT] || undefined
    : undefined;
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

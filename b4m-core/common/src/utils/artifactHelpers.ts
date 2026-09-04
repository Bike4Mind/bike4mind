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

/** Segments a parseable id has - the same count `useArtifactVersions` gates version history on. */
const PARSEABLE_SEGMENTS = 5;

/** Collapses a field to one id segment: no `_`, so the positions after it cannot shift. */
function idSegment(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback
  );
}

/**
 * Assembles the id. `identifier` is written VERBATIM, so every caller has to hand over a value that
 * is already one segment - `idSegment` output, or a segment read back out of an existing id.
 */
function mintArtifactId(type: string, identifier: string): string {
  // `id` is globally unique in the DB and the timestamp does not separate two artifacts minted in
  // the same millisecond, so the index position carries a random integer instead: this minter
  // writes one artifact at a time and so has no batch index to record there. It stays an INTEGER,
  // and the id stays five segments, because `generateCompleteArtifactId` (the sibling minter)
  // records a real integer index in that position - the two have to agree on what every position
  // holds, not just where it sits. The by-id route also has a fallback matching a short
  // `artifact_{type}_{identifier}` request against `^<request>_\d+_\d+$`, which assumes the same
  // thing, though it is unreachable today: `artifactService.get` throws on a miss instead of
  // returning the null it tests for.
  const discriminator = Math.floor(Math.random() * 1e12);
  return `artifact_${idSegment(type, 'generated')}_${identifier}_${Date.now()}_${discriminator}`;
}

/**
 * Mints an artifact id in the shape the client parses: `artifact_{type}_{identifier}_{timestamp}_{index}`.
 *
 * Every position is read by name somewhere, so none can move and none can change type:
 * `useArtifactVersions` (app/hooks/data/artifacts.ts) treats an id with fewer than five segments
 * as legacy and skips fetching version history; `getStableTimestamp` (KnowledgeViewer,
 * knowledgeViewerSorting) reads segment 3 as a number; `findExistingArtifactId`
 * (app/utils/artifactPersistence.ts) compares segment 2 for equality against the identifier the
 * rendered card parsed out of the reply, which is how that card adopts this row instead of minting
 * an id of its own.
 *
 * `identifier` here is a TITLE or a similar free string, so it is slugified to fit one segment.
 * That makes it match the reply's `identifier` attribute only when the two happen to agree; use
 * `remintArtifactId` when an id for the same artifact already exists and the attribute is known.
 *
 * `apps/client/app/utils/artifactParser.ts` exports `generateCompleteArtifactId`, which mints the
 * same shape for artifacts parsed out of a reply and does record a real batch index there. The two
 * are a known fork - see `persistAgentArtifacts.ts` for why they are not interchangeable - but the
 * shape has to stay in sync across both, and the identifier segment is the one the client compares.
 * The fork is a parameterization difference, not a package boundary (apps/client may import this
 * module), so a shared formatter taking `{ type, identifier, timestamp, index }` would merge them.
 * Worth doing for one reason beyond tidiness: only this side strips `_` from the identifier, and
 * that is the invariant the whole positional contract rests on.
 */
export function createArtifactId(type: string = 'generated', identifier?: string): string {
  return mintArtifactId(type, idSegment(identifier ?? '', 'artifact'));
}

/**
 * The identifier segment of an `artifact_`-shaped id, or undefined when `id` is not that shape.
 *
 * This is the field `findExistingArtifactId` matches on, so it is what has to survive when an id is
 * reminted for a copy of an existing artifact: the reply the copy is rendered from still carries the
 * original `<artifact identifier=...>` attribute, and that attribute is what this segment holds.
 *
 * Gated on the full segment count, not just on there being a segment 2: a legacy
 * `artifact_{timestamp}_{random}` id has one, and it holds the random discriminator rather than any
 * identifier. Returning that would hand the caller a confident answer that matches no attribute and
 * silently skip whatever fallback it has.
 */
export function getArtifactIdentifier(id: string): string | undefined {
  const segments = id.split('_');
  return id.startsWith('artifact_') && segments.length >= PARSEABLE_SEGMENTS
    ? segments[IDENTIFIER_SEGMENT] || undefined
    : undefined;
}

/**
 * A fresh id for a copy of the artifact `sourceId` names, keeping the identifier segment intact.
 *
 * The segment is carried across UNSLUGIFIED, unlike the one `createArtifactId` derives from a title:
 * `findExistingArtifactId` compares it for equality against the raw `<artifact identifier=...>`
 * attribute, and `generateCompleteArtifactId` wrote that attribute into the source id raw too. So
 * lowercasing it, or truncating a long one, is enough to stop the rendered card adopting this row -
 * it mints an id of its own instead and the version history the copy just inherited is orphaned.
 * Splitting on `_` is what guarantees the value still fits one segment.
 *
 * Falls back to slugifying `title` when `sourceId` is not the parseable shape, which is the only
 * case where there is no attribute to preserve.
 */
export function remintArtifactId(sourceId: string, type: string, title: string): string {
  const identifier = getArtifactIdentifier(sourceId);
  return identifier ? mintArtifactId(type, identifier) : createArtifactId(type, title);
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

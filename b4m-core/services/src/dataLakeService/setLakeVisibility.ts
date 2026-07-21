import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/**
 * Private = owner-only (no org, not public); organization = scoped to the actor's own org;
 * public = readable app-wide (directory-listed, cross-org). The three are mutually exclusive.
 */
export type LakeVisibility = 'private' | 'organization' | 'public';

interface SetLakeVisibilityAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'find'>;
  };
}

/**
 * Set a lake's visibility across the tri-state private | organization | public. Org promotion
 * targets `actor.organizationId` - the caller's active-switcher org, which the route already
 * authorization-validated (resolveActiveOrg) to be one they belong to, so a user can't plant a
 * lake into an org they're not a member of (same rule as createDataLake).
 *
 * Any promotion that EXPOSES the lake beyond the owner (org OR public) is owner-only: a platform
 * admin must not share/expose someone else's lake on their behalf. Demotion to private stays
 * owner/admin (it only removes exposure). Publishing is refused for a gated lake - a gate
 * (PHI/entitlement boundary) must never be exposed app-wide; gated cross-org sharing already
 * exists via `requiredEntitlement`, so `public` here means truly open/gate-less.
 *
 * Keeps the existing `datalakeTag` (an opaque join key - nothing parses it for org), so no file
 * re-tag/migration is needed; the access paths scope by the `organizationId`/`isPublic` fields.
 * Only those two fields change.
 */
export const setLakeVisibility = async (
  actor: { userId: string; isAdmin: boolean; organizationId?: string },
  dataLakeId: string,
  visibility: LakeVisibility,
  { db }: SetLakeVisibilityAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the creator can change a data lake’s visibility');
  }
  const exposes = visibility === 'organization' || visibility === 'public';
  // Exposing (org or public) targets the ACTOR's own scope, so only the owner may do it -
  // otherwise a platform admin acting on someone else's lake would expose it without consent
  // (and org promotion would pull it into the admin's org). Demotion to private stays owner/admin.
  if (exposes && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the lake’s owner can change how it is shared.');
  }
  if (visibility === 'organization' && !actor.organizationId) {
    throw new BadRequestError('You are not part of an organization, so this lake can’t be shared to one.');
  }
  // PHI/access-gate guardrail: a gated lake must not be exposed app-wide. Refuse to publish it -
  // gated cross-org sharing is the `requiredEntitlement` path, not `public`.
  if (visibility === 'public' && (existing.requiredUserTag || existing.requiredEntitlement)) {
    throw new BadRequestError(
      'A data lake with an access tag or required entitlement can’t be made public. Remove the gate first, or share it through the entitlement instead.'
    );
  }

  const targetIsPublic = visibility === 'public';
  const targetOrg = visibility === 'organization' ? actor.organizationId : undefined;
  const currentIsPublic = !!existing.isPublic;
  const currentOrg = existing.organizationId || undefined;
  if (currentIsPublic === targetIsPublic && currentOrg === targetOrg) {
    return existing; // already in the requested visibility - no-op
  }

  // Slug uniqueness is scoped by (organizationId, slug). Only a scope MOVE (org change) can
  // introduce a collision; flipping isPublic within the same org scope cannot. Guard the move
  // and surface a clear error instead of a raw E11000. (Same scope shape as createDataLake.)
  if (currentOrg !== targetOrg) {
    const scope = targetOrg ? { organizationId: targetOrg } : { organizationId: { $in: [null, ''] } };
    const clashes = await db.dataLakes.find({ ...scope, slug: existing.slug });
    if (clashes.some(l => l.id !== existing.id)) {
      throw new BadRequestError(
        `A data lake with the slug “${existing.slug}” already exists in the target scope — rename one first.`
      );
    }
  }

  // null (not undefined) clears organizationId: Mongoose $set skips undefined but writes null,
  // and the access queries treat null/'' as org-less. isPublic is always set explicitly (false
  // on demotion clears a prior publish). Cast: organizationId is typed optional-string.
  let updated: IDataLakeDocument | null;
  try {
    updated = await db.dataLakes.update({
      id: dataLakeId,
      organizationId: targetOrg ?? null,
      isPublic: targetIsPublic,
    } as Partial<IDataLakeDocument>);
  } catch (err) {
    // A concurrent create/rename can win the (organizationId, slug) unique index between the
    // find pre-check above and this write (TOCTOU) - map the raw duplicate-key to the same
    // friendly error rather than surfacing a 500.
    if ((err as { code?: number })?.code === 11000) {
      throw new BadRequestError(
        `A data lake with the slug “${existing.slug}” already exists in the target scope — rename one first.`
      );
    }
    throw err;
  }
  if (!updated) {
    throw new NotFoundError('Data lake not found after visibility change');
  }
  return updated;
};

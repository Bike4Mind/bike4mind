import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/** Private = owner-only (no org); organization = scoped to the actor's own org. */
export type LakeVisibility = 'private' | 'organization';

interface SetLakeVisibilityAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'find'>;
  };
}

/**
 * Promote a personal lake to org-scoped, or demote it back to private. The target org is
 * `actor.organizationId` - the caller's active-switcher org, which the route already
 * authorization-validated (resolveActiveOrg) to be one they belong to, so a user can't plant
 * a lake into an org they're not a member of (same rule as createDataLake). Owner/admin only.
 *
 * Keeps the existing `datalakeTag` (an opaque join key - nothing parses it for org), so no
 * file re-tag/migration is needed; both access paths already scope by the organizationId
 * field. Only the lake's `organizationId` changes.
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
  // Promotion targets the ACTOR's own org, so only the owner may promote - otherwise a
  // platform admin acting on someone else's lake would pull it into the admin's org. Demotion
  // to private stays owner/admin (it only removes scope, never moves the lake into an org).
  if (visibility === 'organization' && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the lake’s owner can share it to an organization.');
  }
  if (visibility === 'organization' && !actor.organizationId) {
    throw new BadRequestError('You are not part of an organization, so this lake can’t be shared to one.');
  }

  const targetOrg = visibility === 'organization' ? actor.organizationId : undefined;
  const currentOrg = existing.organizationId || undefined;
  if (currentOrg === targetOrg) {
    return existing; // already in the requested visibility - no-op
  }

  // Slug uniqueness is scoped by (organizationId, slug). Moving into the target scope would
  // violate that unique index if a DIFFERENT lake already holds this slug there - surface a
  // clear error instead of a raw E11000. (Same scope shape as createDataLake's disambiguation.)
  const scope = targetOrg ? { organizationId: targetOrg } : { organizationId: { $in: [null, ''] } };
  const clashes = await db.dataLakes.find({ ...scope, slug: existing.slug });
  if (clashes.some(l => l.id !== existing.id)) {
    throw new BadRequestError(
      `A data lake with the slug “${existing.slug}” already exists in the target scope — rename one first.`
    );
  }

  // null (not undefined) clears the field: Mongoose $set skips undefined but writes null, and
  // the access queries treat null/'' as org-less. Cast: organizationId is typed optional-string.
  let updated: IDataLakeDocument | null;
  try {
    updated = await db.dataLakes.update({
      id: dataLakeId,
      organizationId: targetOrg ?? null,
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

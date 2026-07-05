import type { AccessContext, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { DATALAKE_TAG_PREFIX } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { assertLakeAccess } from './assertLakeAccess';

/** The acting principal for a write/manage decision - resolved from auth, never the body. */
type ManageActor = Pick<AccessContext, 'userId' | 'isAdmin'>;

/**
 * The single WRITE/MANAGE decision for a lake: platform admin, or the lake's creator. This is
 * the exact rule the remove path (`removeFileFromDataLake`) and the visibility change already
 * enforce inline - centralized here so every mutating path agrees on who may write.
 *
 * Deliberately narrower than `canAccessLake` (read): a tag/entitlement/org grant lets a member
 * READ a lake but NOT write into it. Injecting a file (applying the lake's meta-tag) is a write,
 * so it must clear this gate, closing the read-can-write asymmetry.
 */
export function canManageLake(lake: Pick<IDataLakeDocument, 'createdByUserId'>, actor: ManageActor): boolean {
  return actor.isAdmin || lake.createdByUserId === actor.userId;
}

/**
 * Resolve a lake by id-or-slug and assert the caller may WRITE into it. Read access is checked
 * first (via the shared gate), so a caller who can't even see the lake gets a not-found (no
 * existence leak); a reader who isn't the creator/admin gets a manage-denied error mirroring the
 * remove path. Returns the lake on grant. Used by the batch upload doors, which already hold the
 * lake's id/slug.
 */
export const assertLakeWriteAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  { db }: { db: { dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'> } }
): Promise<IDataLakeDocument> => {
  const lake = await assertLakeAccess(lakeIdOrSlug, ctx, { db });
  if (!canManageLake(lake, ctx)) {
    throw new BadRequestError('Only the creator can add files to this data lake');
  }
  return lake;
};

/**
 * Gate the file-tag write paths (Send-to-Data-Lake, direct create/update, tag toggle): given the
 * `datalake:*` meta-tags a caller is applying to a file, assert they may write into EVERY
 * referenced lake. Non-meta tags are ignored. A meta-tag that resolves to no lake, or to a lake
 * the caller can't manage, is rejected - this is the check that stops a read-only member from
 * injecting a file into a lake they don't own, mirroring the creator check on the remove path.
 */
export const assertCanWriteDataLakeTags = async (
  actor: ManageActor,
  // `readonly unknown[]`: some callers (e.g. PUT /api/files/{id}) pass raw, un-validated tag
  // names, so a malformed entry (`{ name: null }`) can reach here. Narrowing to string BELOW
  // makes a bad payload fail closed as a 400, never a TypeError -> 500.
  tagNames: readonly unknown[],
  { db }: { db: { dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'> } }
): Promise<void> => {
  // `datalakeTag` values are canonically lowercase (slug + hex org id), so normalize the lookup
  // key - a mixed-case meta-tag still resolves to (and is authorized against) its real lake.
  const metaTags = Array.from(
    new Set(
      tagNames
        .filter((name): name is string => typeof name === 'string')
        .map(name => name.toLowerCase())
        .filter(name => name.startsWith(DATALAKE_TAG_PREFIX))
    )
  );
  for (const tag of metaTags) {
    const lake = await db.dataLakes.findByDatalakeTag(tag);
    if (!lake || !canManageLake(lake, actor)) {
      throw new BadRequestError('Only the creator can add files to this data lake');
    }
  }
};

import type {
  AccessContext,
  BrowsePublicDataLakesResult,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  PublicDataLakeSummary,
} from '@bike4mind/common';
import { canManageLake, isEffectiveOwner, type LakeGrant } from './manageRule';

/**
 * The browsing caller: the full access context, not just an id. The catalog is per-caller (a
 * gated public lake is discoverable by the users who hold its gate), and the manage label needs
 * the org-admin set to honor the org-manageable rung - `ManageActor` is a subset of this.
 */
type BrowseActor = AccessContext;

interface BrowsePublicDataLakesOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Owner fields this service reads. This type narrows what the code below is allowed to touch,
 * not what the query fetches: `userRepository.findByIds` is shared with other callers that do
 * need `email` (e.g. admin usage reports), so its Mongo projection still includes it, and the
 * real result object carries it in memory - this service just never reads or maps it out.
 */
type OwnerLookup = { id: string; name?: string; username?: string }[];

interface BrowsePublicDataLakesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findPublicLakes'>;
    users: { findByIds: (ids: string[]) => Promise<OwnerLookup> };
    /** Optional: makes the isOwn/canManage labels honor curator + transferred-owner grants. */
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listActiveByLakes'>;
  };
}

/**
 * The discover/browse catalog of public data lakes. Returns one page of the public lakes this
 * caller can reach (the repo enforces public + active + the same gate `findAccessible` applies,
 * so discover and access never disagree) enriched with the preview metadata the
 * catalog renders: owner display name, file count, total size, plus per-caller `isOwn`/
 * `canManage` so the UI can gate management affordances. This is a read-only discovery
 * surface - it grants nothing; access is already ambient once a lake is public (a public
 * lake's knowledge is retrievable by everyone), so there is no "subscribe" step.
 *
 * Owner display is name-or-username only. It intentionally never falls back to the owner's
 * email: browsing is cross-org and app-wide, so surfacing an address would leak PII to
 * strangers. An unresolved owner (deleted account) simply yields `undefined`.
 */
export const browsePublicDataLakes = async (
  actor: BrowseActor,
  opts: BrowsePublicDataLakesOptions,
  { db }: BrowsePublicDataLakesAdapters
): Promise<BrowsePublicDataLakesResult> => {
  const { lakes, total } = await db.dataLakes.findPublicLakes(actor, {
    search: opts.search,
    limit: opts.limit,
    offset: opts.offset,
  });

  // Batch-resolve owners in one round-trip. Dedupe ids and drop blanks so a lake with a
  // missing/empty createdByUserId doesn't widen the query.
  const ownerIds = Array.from(new Set(lakes.map(l => l.createdByUserId).filter((id): id is string => !!id)));
  const owners = ownerIds.length > 0 ? await db.users.findByIds(ownerIds) : [];
  const nameById = new Map(owners.map(u => [String(u.id), u.name || u.username || undefined]));

  // Active grants for this page's lakes (one query) so the labels honor curator/transferred-owner
  // grants; empty when no grant repo is wired (labels then use the org-admin rung + creator only).
  const grantsByLake = new Map<string, LakeGrant[]>();
  if (db.dataLakeAccessGrants && lakes.length > 0) {
    const rows = await db.dataLakeAccessGrants.listActiveByLakes(
      lakes.map(l => l.id),
      { activeAsOf: new Date() }
    );
    for (const row of rows) {
      const list = grantsByLake.get(row.dataLakeId) ?? [];
      list.push({ principalType: row.principalType, principalId: row.principalId, role: row.role });
      grantsByLake.set(row.dataLakeId, list);
    }
  }

  const data: PublicDataLakeSummary[] = lakes.map((lake: IDataLakeDocument) => {
    const grants = grantsByLake.get(lake.id);
    // isEffectiveOwner, not canManageLake: isOwn has no admin/curator/org-admin bypass.
    const isOwn = isEffectiveOwner(lake, actor, grants);
    return {
      id: lake.id,
      slug: lake.slug,
      name: lake.name,
      description: lake.description,
      fileTagPrefix: lake.fileTagPrefix,
      ownerDisplayName: nameById.get(lake.createdByUserId),
      fileCount: lake.fileCount ?? 0,
      totalSizeBytes: lake.totalSizeBytes ?? 0,
      isOwn,
      canManage: canManageLake(lake, actor, grants),
    };
  });

  return { data, total };
};

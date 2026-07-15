import type { AccessContext, IDataLakeDocument, IDataLakeRepository, DataLakeConfig } from '@bike4mind/common';
import { DATA_LAKES, toDataLakeConfig, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';

interface ListDataLakesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findAccessible' | 'find'>;
  };
}

const toConfig = (dl: IDataLakeDocument): DataLakeConfig => toDataLakeConfig(dl);

/**
 * Per-lake write/manage flag for the caller. Mirrors canManageLake (admin or creator)
 * so the client's management affordances agree with what the write paths enforce. Kept
 * local rather than importing authorizeLakeWrite to avoid a cycle - it is a one-liner.
 */
const canManage = (dl: Pick<IDataLakeDocument, 'createdByUserId'>, ctx: AccessContext): boolean =>
  ctx.isAdmin || dl.createdByUserId === ctx.userId;

/**
 * Lists data lakes accessible to the user (org-aware datastore filter + hardcoded
 * fallbacks). Uses the same owner/org/(tag-or-entitlement) rule as the single access
 * gate, so a non-owner never receives lakes outside their org or whose required tag AND
 * required entitlement they both lack. Each result carries `canManage` (admin or creator)
 * so the UI can gate management affordances - the list surfaces other users' public lakes,
 * which are read-only. Fallback (built-in) lakes are read-only for everyone.
 */
export const listDataLakes = async (ctx: AccessContext, { db }: ListDataLakesAdapters): Promise<DataLakeConfig[]> => {
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.findAccessible(ctx, { statuses: ['draft', 'active'] });
  } catch {
    // DB may not have the collection yet - fall through to hardcoded
  }

  const dynamicConfigs = dynamicLakes.map(dl => ({ ...toConfig(dl), canManage: canManage(dl, ctx) }));

  // Merge with hardcoded fallbacks (DB entries take precedence by slug/id).
  const dynamicIds = new Set(dynamicLakes.map(d => d.slug));
  const fallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id));

  const normalizedUserTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);
  const accessibleFallbacks = fallbacks
    .filter(dl => lakeMatchesAccess(dl, normalizedUserTags, normalizedKeys))
    .map(dl => ({ ...dl, canManage: false }));

  return [...dynamicConfigs, ...accessibleFallbacks];
};

/**
 * Lists ALL data lakes (for admin views). No user-tag filtering. Admins may manage every
 * DB lake, so `canManage` is true for those; fallback (built-in) lakes stay read-only for
 * everyone (assertLakeWritable refuses them even for admins), so they are false.
 */
export const listAllDataLakes = async ({ db }: ListDataLakesAdapters): Promise<DataLakeConfig[]> => {
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.find({ status: { $in: ['draft', 'active'] } });
  } catch {
    // Fall through to hardcoded
  }

  const dynamicConfigs = dynamicLakes.map(dl => ({ ...toConfig(dl), canManage: true }));
  const dynamicIds = new Set(dynamicLakes.map(d => d.slug));
  const fallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id)).map(dl => ({ ...dl, canManage: false }));

  return [...dynamicConfigs, ...fallbacks];
};

/**
 * Archived lakes accessible to the user (management view: unarchive). includePublic:false -
 * this is a management view (restore is owner/admin-only), so it must NOT surface strangers'
 * public lakes; the owner still sees their own archived public lake via the owner arm.
 */
export const listArchivedDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<IDataLakeDocument[]> => {
  return db.dataLakes.findAccessible(ctx, { statuses: ['archived'], includePublic: false });
};

/**
 * Soft-deleted lakes accessible to the user (management view: cleanup / restore). includePublic:
 * false for the same reason as the archived view - a stranger has no management role on someone
 * else's public lake.
 */
export const listDeletedDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<IDataLakeDocument[]> => {
  return db.dataLakes.findAccessible(ctx, { statuses: ['deleted'], includePublic: false });
};

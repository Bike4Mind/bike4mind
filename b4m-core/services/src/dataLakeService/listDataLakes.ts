import type {
  AccessContext,
  IDataLakeDocument,
  IDataLakeRepository,
  DataLakeConfig,
  ManageableDataLakeConfig,
} from '@bike4mind/common';
import { DATA_LAKES, toDataLakeConfig, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { redactLakesForActor, type ReaderDataLake } from './redactLakeForActor';

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
 * The one place a list response may carry an editor-only field: the shared config, the caller's
 * manage flag, and `systemPrompt` ONLY when that flag holds. `toDataLakeConfig` has no actor and
 * so cannot carry it (see ManageableDataLakeConfig); the raw-document exits use the sibling
 * `redactLakeForActor` instead. A blank/whitespace prompt is treated as unset so the client
 * doesn't have to distinguish '' from absent, and the value is sent TRIMMED so seeding the editor
 * from this response and saving it back cannot rewrite stored padding the user never touched.
 */
const toManageableConfig = (dl: IDataLakeDocument, manageable: boolean): ManageableDataLakeConfig => ({
  ...toConfig(dl),
  canManage: manageable,
  ...(manageable && dl.systemPrompt?.trim() ? { systemPrompt: dl.systemPrompt.trim() } : {}),
  // Editor-only, same gate as systemPrompt. An empty stored value means "no preferred prompt",
  // so it is reported as absent (never '') - the picker then shows "None".
  ...(manageable && dl.preferredSystemPromptId ? { preferredSystemPromptId: dl.preferredSystemPromptId } : {}),
});

/**
 * Fallback (built-in) registry entries as list results. Routed through `toDataLakeConfig` rather
 * than spread, so the "an actor-less projection cannot carry an editor-only field" invariant holds
 * on this arm too: `PREMIUM_DATA_LAKES` is `JSON.parse`d from env and keeps unknown keys, so an
 * overlay entry carrying a `systemPrompt` would otherwise be served to every caller. Fallbacks have
 * no owner and are read-only for everyone, so `canManage` is always false.
 */
const toFallbackConfig = (dl: DataLakeConfig): ManageableDataLakeConfig => ({
  ...toDataLakeConfig(dl),
  canManage: false,
});

/**
 * Lists data lakes accessible to the user (org-aware datastore filter + hardcoded
 * fallbacks). Uses the same owner/org/(tag-or-entitlement) rule as the single access
 * gate, so a non-owner never receives lakes outside their org or whose required tag AND
 * required entitlement they both lack. Each result carries `canManage` (admin or creator)
 * so the UI can gate management affordances - the list surfaces other users' public lakes,
 * which are read-only. Fallback (built-in) lakes are read-only for everyone.
 */
export const listDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<ManageableDataLakeConfig[]> => {
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.findAccessible(ctx, { statuses: ['draft', 'active'] });
  } catch {
    // DB may not have the collection yet - fall through to hardcoded
  }

  const dynamicConfigs = dynamicLakes.map(dl => toManageableConfig(dl, canManage(dl, ctx)));

  // Merge with hardcoded fallbacks (DB entries take precedence by slug/id).
  const dynamicIds = new Set(dynamicLakes.map(d => d.slug));
  const fallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id));

  const normalizedUserTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);
  const accessibleFallbacks = fallbacks
    .filter(dl => lakeMatchesAccess(dl, normalizedUserTags, normalizedKeys))
    .map(toFallbackConfig);

  return [...dynamicConfigs, ...accessibleFallbacks];
};

/**
 * Lists ALL data lakes (for admin views). No user-tag filtering. Admins may manage every
 * DB lake, so `canManage` is true for those; fallback (built-in) lakes stay read-only for
 * everyone (assertLakeWritable refuses them even for admins), so they are false.
 */
export const listAllDataLakes = async ({ db }: ListDataLakesAdapters): Promise<ManageableDataLakeConfig[]> => {
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.find({ status: { $in: ['draft', 'active'] } });
  } catch {
    // Fall through to hardcoded
  }

  const dynamicConfigs = dynamicLakes.map(dl => toManageableConfig(dl, true));
  const dynamicIds = new Set(dynamicLakes.map(d => d.slug));
  const fallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id)).map(toFallbackConfig);

  return [...dynamicConfigs, ...fallbacks];
};

/**
 * Archived lakes accessible to the user (management view: unarchive). includePublic:false -
 * this is a management view (restore is owner/admin-only), so it must NOT surface strangers'
 * public lakes; the owner still sees their own archived public lake via the owner arm.
 *
 * Returns raw documents, and the org arm still yields lakes the caller does not own, so the
 * editor-only fields are redacted per lake before they leave the service.
 */
export const listArchivedDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<(IDataLakeDocument | ReaderDataLake)[]> => {
  const lakes = await db.dataLakes.findAccessible(ctx, { statuses: ['archived'], includePublic: false });
  return redactLakesForActor(lakes, ctx);
};

/**
 * Soft-deleted lakes accessible to the user (management view: cleanup / restore). includePublic:
 * false for the same reason as the archived view - a stranger has no management role on someone
 * else's public lake. Editor-only fields are redacted per lake, as in the archived view.
 */
export const listDeletedDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<(IDataLakeDocument | ReaderDataLake)[]> => {
  const lakes = await db.dataLakes.findAccessible(ctx, { statuses: ['deleted'], includePublic: false });
  return redactLakesForActor(lakes, ctx);
};

import type {
  AccessContext,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  DataLakeConfig,
  ManageableDataLakeConfig,
} from '@bike4mind/common';
import { DATA_LAKES, toDataLakeConfig, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { canManageLake, isEffectiveOwner, type LakeGrant } from './manageRule';
import { redactLakesForActor, type ReaderDataLake } from './redactLakeForActor';
import { resolveEnforceReadGrants } from './resolveLakeReadAccess';

/** Grant-repo slice the list labels need: batch-read a set of lakes' grants, and one principal's. */
type GrantLookup = Pick<IDataLakeAccessGrantRepository, 'listActiveByLakes' | 'listByPrincipal'>;

/** Settings slice for the read-time grant cutover flag - governs reader-grant inclusion in the list. */
type SettingsLookup = Pick<IAdminSettingsRepository, 'getSettingsValue'>;

/**
 * The active grants for a set of lakes, grouped by lake id, so per-lake `canManage`/`isOwn` labels
 * are grant-aware in ONE query. Empty when no grant repo is wired - labels then fall back to the
 * org-admin rung (from `ctx.administeredOrgIds`) plus the createdByUserId owner fallback, which is
 * the pre-grant behavior.
 */
const grantsByLakeIdFor = async (
  lakes: Pick<IDataLakeDocument, 'id'>[],
  grants?: GrantLookup
): Promise<Map<string, LakeGrant[]>> => {
  const byLake = new Map<string, LakeGrant[]>();
  if (!grants || lakes.length === 0) return byLake;
  const rows = await grants.listActiveByLakes(
    lakes.map(l => l.id),
    { activeAsOf: new Date() }
  );
  for (const row of rows) {
    const list = byLake.get(row.dataLakeId) ?? [];
    list.push({ principalType: row.principalType, principalId: row.principalId, role: row.role });
    byLake.set(row.dataLakeId, list);
  }
  return byLake;
};

/**
 * Lake ids the caller holds an active USER-principal grant on - fed to findAccessible so a
 * transferred/delegated lake lists. Stays in lockstep with the single read gate (#1673):
 *  - owner/curator ALWAYS included: the gate admits them via `canManageLake`.
 *  - reader included ONLY when `includeReaders` (the enforced read-time grant cutover): matching the
 *    gate, which honors a reader grant only once EnforceLakeReadGrants is on. In report-only, a
 *    reader-granted lake would 404 on open, so listing it would be incoherent - it is excluded.
 * Only resolves USER-principal grants - org-principal grants (rung 5) are a deferred Lane B follow-up
 * (manageable by direct id today); membership never crosses orgs regardless (epic decision 12).
 */
const grantedLakeIdsFor = async (userId: string, grants?: GrantLookup, includeReaders = false): Promise<string[]> => {
  if (!grants) return [];
  const rows = await grants.listByPrincipal('user', userId, { activeAsOf: new Date() });
  return Array.from(
    new Set(
      rows
        .filter(row => row.role === 'owner' || row.role === 'curator' || (includeReaders && row.role === 'reader'))
        .map(row => row.dataLakeId)
    )
  );
};

/**
 * Owner fields this service reads to label non-own lakes. Narrows what the code may touch, not
 * what the query fetches - the shared `findByIds` still projects `email` for other callers, but
 * this service never reads it (owner display is name-or-username only, never an address).
 */
type OwnerLookup = { id: string; name?: string; username?: string }[];

interface ListDataLakesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findAccessible' | 'find'>;
    /**
     * Optional owner-name lookup. When present (the manager list route), the projection labels
     * lakes the caller does NOT own with the creator's display name, so a global admin (who sees
     * every tenant's lakes) or an org member can't mistake someone else's lake for their own.
     * Omitted by the content-scope resolver and Slack, which never render the owner and must not
     * pay for the extra query - `isOwn` is still computed for them (it is free), just unlabeled.
     */
    users?: { findByIds: (ids: string[]) => Promise<OwnerLookup> };
    /**
     * Optional access-grant repo. When present, `canManage`/`isOwn` labels honor curator and
     * transferred-owner grants, and a lake the caller holds a grant on (but is neither creator nor
     * org-admin of) still appears via findAccessible's grant arm. Absent -> labels use the org-admin
     * rung + createdByUserId fallback only.
     */
    dataLakeAccessGrants?: GrantLookup;
    /**
     * Optional settings repo for the read-time grant cutover flag (#1673). When present and
     * EnforceLakeReadGrants is on, reader-granted lakes list too (in lockstep with the single gate).
     * Absent OR a failed read -> report-only, so reader-granted lakes are NOT listed (legacy behavior).
     */
    settings?: SettingsLookup;
  };
}

const toConfig = (dl: IDataLakeDocument): DataLakeConfig => toDataLakeConfig(dl);

/**
 * Batch-resolve creator display names (name || username, never email - the same PII rule as the
 * discover catalog) for the lakes the caller does not own, in one round-trip. Returns an empty
 * map when no user lookup was supplied, so a caller that never renders owners pays nothing. Own
 * lakes are excluded from the id set: they render as "you", never by name.
 */
const resolveOwnerNames = async (
  lakes: IDataLakeDocument[],
  callerUserId: string,
  users?: { findByIds: (ids: string[]) => Promise<OwnerLookup> }
): Promise<Map<string, string>> => {
  if (!users) return new Map();
  const ownerIds = Array.from(
    new Set(lakes.filter(l => l.createdByUserId && l.createdByUserId !== callerUserId).map(l => l.createdByUserId))
  );
  if (ownerIds.length === 0) return new Map();
  const owners = await users.findByIds(ownerIds);
  const nameById = new Map<string, string>();
  for (const u of owners) {
    const name = u.name || u.username;
    if (name) nameById.set(String(u.id), name);
  }
  return nameById;
};

/**
 * The one place a list response may carry an editor-only field: the shared config, the caller's
 * manage flag, and `systemPrompt` ONLY when that flag holds. `toDataLakeConfig` has no actor and
 * so cannot carry it (see ManageableDataLakeConfig); the raw-document exits use the sibling
 * `redactLakeForActor` instead. A blank/whitespace prompt is treated as unset so the client
 * doesn't have to distinguish '' from absent, and the value is sent TRIMMED so seeding the editor
 * from this response and saving it back cannot rewrite stored padding the user never touched.
 */
const toManageableConfig = (
  dl: IDataLakeDocument,
  manageable: boolean,
  isOwn: boolean,
  ownerDisplayName?: string
): ManageableDataLakeConfig => ({
  ...toConfig(dl),
  canManage: manageable,
  isOwn,
  // Owner name is a not-own label only: an own lake reads as "you", and it is set only when the
  // projection actually resolved one (name-or-username, never email - see resolveOwnerNames).
  ...(!isOwn && ownerDisplayName ? { ownerDisplayName } : {}),
  ...(manageable && dl.systemPrompt?.trim() ? { systemPrompt: dl.systemPrompt.trim() } : {}),
  // Editor-only, same gate as systemPrompt. An empty stored value means "no preferred prompt",
  // so it is reported as absent (never '') - the picker then shows "None".
  ...(manageable && dl.preferredSystemPromptId ? { preferredSystemPromptId: dl.preferredSystemPromptId } : {}),
  // Editor-only, same gate as the prompt fields. Surfaced so the settings picker can seed the
  // current selection; absent for a non-editor OR a lake predating the field (the picker then
  // falls back to the default mode, matching how the resolver treats an absent value).
  ...(manageable && dl.groundingMode ? { groundingMode: dl.groundingMode } : {}),
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
  // Built-in registry lakes have no creator, so they are never "yours" and carry no owner label.
  isOwn: false,
});

/**
 * Lists data lakes accessible to the user (org-aware datastore filter + hardcoded
 * fallbacks). Uses the same owner/org/(tag-or-entitlement) rule as the single access
 * gate, so a non-owner never receives lakes outside their org or whose required tag AND
 * required entitlement they both lack. Each result carries `canManage` (admin or creator)
 * so the UI can gate management affordances - the list surfaces other users' public lakes,
 * which are read-only. Fallback (built-in) lakes are read-only for everyone.
 *
 * Each result also carries `isOwn` (did the caller create it) and, when a `users` lookup is
 * supplied (the manager route), `ownerDisplayName` for lakes the caller does NOT own - so the
 * UI can flag someone else's lake and not let it be managed by mistake.
 */
export const listDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<ManageableDataLakeConfig[]> => {
  const includeReaders = await resolveEnforceReadGrants(db.settings);
  const grantedLakeIds = await grantedLakeIdsFor(ctx.userId, db.dataLakeAccessGrants, includeReaders);
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.findAccessible(ctx, { statuses: ['draft', 'active'], grantedLakeIds });
  } catch {
    // DB may not have the collection yet - fall through to hardcoded
  }

  // Label lakes the caller does not own with the creator's name (manager route only; the
  // content-scope resolver passes no `users` adapter and this resolves to an empty map).
  const ownerNames = await resolveOwnerNames(dynamicLakes, ctx.userId, db.users);
  const grantsByLake = await grantsByLakeIdFor(dynamicLakes, db.dataLakeAccessGrants);
  const dynamicConfigs = dynamicLakes.map(dl => {
    const grants = grantsByLake.get(dl.id);
    return toManageableConfig(
      dl,
      canManageLake(dl, ctx, grants),
      isEffectiveOwner(dl, ctx, grants),
      ownerNames.get(dl.createdByUserId)
    );
  });

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
 *
 * Takes `ctx` (not just `db`) so it can mark which of those cross-tenant lakes the admin
 * actually owns (`isOwn`) and, when a `users` lookup is supplied, label the rest with the
 * creator's name - an admin sees every org's private lakes here, so the owner label is what
 * keeps them from mistaking someone else's for their own.
 */
export const listAllDataLakes = async (
  ctx: AccessContext,
  { db }: ListDataLakesAdapters
): Promise<ManageableDataLakeConfig[]> => {
  let dynamicLakes: IDataLakeDocument[] = [];
  try {
    dynamicLakes = await db.dataLakes.find({ status: { $in: ['draft', 'active'] } });
  } catch {
    // Fall through to hardcoded
  }

  const ownerNames = await resolveOwnerNames(dynamicLakes, ctx.userId, db.users);
  const grantsByLake = await grantsByLakeIdFor(dynamicLakes, db.dataLakeAccessGrants);
  // Admin manages every DB lake (canManage: true), but isOwn stays the true effective-owner test so
  // the "you" label still means ownership, not the admin's blanket manage power.
  const dynamicConfigs = dynamicLakes.map(dl =>
    toManageableConfig(dl, true, isEffectiveOwner(dl, ctx, grantsByLake.get(dl.id)), ownerNames.get(dl.createdByUserId))
  );
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
  const includeReaders = await resolveEnforceReadGrants(db.settings);
  const grantedLakeIds = await grantedLakeIdsFor(ctx.userId, db.dataLakeAccessGrants, includeReaders);
  const lakes = await db.dataLakes.findAccessible(ctx, {
    statuses: ['archived'],
    includePublic: false,
    grantedLakeIds,
  });
  const grantsByLake = await grantsByLakeIdFor(lakes, db.dataLakeAccessGrants);
  return redactLakesForActor(lakes, ctx, grantsByLake);
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
  const includeReaders = await resolveEnforceReadGrants(db.settings);
  const grantedLakeIds = await grantedLakeIdsFor(ctx.userId, db.dataLakeAccessGrants, includeReaders);
  const lakes = await db.dataLakes.findAccessible(ctx, { statuses: ['deleted'], includePublic: false, grantedLakeIds });
  const grantsByLake = await grantsByLakeIdFor(lakes, db.dataLakeAccessGrants);
  return redactLakesForActor(lakes, ctx, grantsByLake);
};

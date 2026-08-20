import type {
  AccessContext,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IFallbackLakeSetting,
  IFallbackLakeSettingsRepository,
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
 * Lake ids the caller can reach via an active grant - fed to findAccessible so a transferred,
 * delegated, or shared lake lists. Stays in lockstep with the single read gate (#1673):
 *  - USER owner/curator ALWAYS included: the gate admits them via `canManageLake`.
 *  - USER reader AND any ORG-principal grant (for an org the caller is a MEMBER of) included ONLY
 *    when `includeReaders` (the enforced read-time grant cutover), matching resolveReadGrant at the
 *    gate. In report-only the gate returns the legacy decision, so a lake reachable only by these
 *    would 404 on open - listing it would be incoherent, so it is excluded until enforce.
 * The org arm keys off MEMBERSHIP (`organizationIds`), distinct from the org-MANAGE rung (admin
 * rights); org membership never crosses orgs regardless (epic decision 12).
 */
const grantedLakeIdsFor = async (
  userId: string,
  organizationIds: string[],
  grants?: GrantLookup,
  includeReaders = false
): Promise<string[]> => {
  if (!grants) return [];
  const activeAsOf = new Date();
  const ids = new Set<string>();

  const userRows = await grants.listByPrincipal('user', userId, { activeAsOf });
  for (const row of userRows) {
    if (row.role === 'owner' || row.role === 'curator' || (includeReaders && row.role === 'reader')) {
      ids.add(row.dataLakeId);
    }
  }

  // Org-principal grants resolve only under enforce: membership in an org holding ANY grant on a
  // lake grants read (mirrors the gate's org read arm). One query per membership org - bounded by
  // how many orgs the caller belongs to.
  if (includeReaders && organizationIds.length > 0) {
    const orgRowSets = await Promise.all(
      organizationIds.map(orgId => grants.listByPrincipal('organization', orgId, { activeAsOf }))
    );
    for (const rows of orgRowSets) for (const row of rows) ids.add(row.dataLakeId);
  }

  return Array.from(ids);
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
    /**
     * Optional overlay lookup for a static (registry) lake's admin-settable session defaults
     * (currently `groundingMode` only - see IFallbackLakeSetting). Absent -> a fallback lake lists
     * with no overlay merge, matching resolveFallbackLake's own graceful degrade.
     */
    fallbackLakeSettings?: Pick<IFallbackLakeSettingsRepository, 'findByLakeIds'>;
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

type FallbackOverlay = Pick<IFallbackLakeSetting, 'groundingMode' | 'preferredSystemPromptId' | 'systemPrompt'>;

/**
 * Batch-resolve the overlay (`groundingMode`, `preferredSystemPromptId`, `systemPrompt`) for a set
 * of fallback lake ids, in one round-trip. Empty map when no overlay repo was supplied (the
 * content-scope resolver / Slack never render these fields) - mirrors `resolveOwnerNames`'s "pay
 * nothing when nobody reads it" shape.
 */
const resolveFallbackSettings = async (
  lakeIds: string[],
  fallbackLakeSettings?: Pick<IFallbackLakeSettingsRepository, 'findByLakeIds'>,
  logger?: { warn?: (msg: string, meta?: unknown) => void }
): Promise<Map<string, FallbackOverlay>> => {
  const byLakeId = new Map<string, FallbackOverlay>();
  if (!fallbackLakeSettings || lakeIds.length === 0) return byLakeId;
  // Guarded like the dynamic-lake read above: these are editor SEED values, so a transient overlay
  // failure must degrade the fallback lakes' settings display, never 500 the whole admin lake list
  // (DB lakes included) - which is what an unguarded await here did.
  let rows: Awaited<ReturnType<typeof fallbackLakeSettings.findByLakeIds>>;
  try {
    rows = await fallbackLakeSettings.findByLakeIds(lakeIds);
  } catch (err) {
    logger?.warn?.('[dataLakes] fallback settings overlay read failed; listing without overrides', err);
    return byLakeId;
  }
  for (const row of rows) {
    byLakeId.set(row.lakeId, {
      groundingMode: row.groundingMode,
      preferredSystemPromptId: row.preferredSystemPromptId,
      systemPrompt: row.systemPrompt,
    });
  }
  return byLakeId;
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
  // A DB lake HAS a document, so rebuild and manage are the same decision - only a fallback
  // (built-in) lake needs the narrower `canRebuild`; see toFallbackConfig and the field's comment.
  canRebuild: manageable,
  // Same reasoning as canRebuild: a DB lake's settings live on its document, so this is identical
  // to canManage here - only a fallback lake needs the narrower ctx.isAdmin gate.
  canManageSettings: manageable,
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
  // Editor-only, same gate. Absent when the lake declares no target, which is exactly the state the
  // settings field renders as blank - and the state in which the lake never converges (#1681).
  ...(manageable && typeof dl.requiredPassageTokenTarget === 'number'
    ? { requiredPassageTokenTarget: dl.requiredPassageTokenTarget }
    : {}),
  // Editor-only, but ALWAYS present (defaulted to 0) when manageable, unlike the fields above -
  // its presence is the client's spend-tab visibility signal, so a zero-spend manageable lake
  // must not look identical to a non-manageable one.
  ...(manageable ? { embeddingSpendMicroUsd: dl.embeddingSpendMicroUsd ?? 0 } : {}),
});

/**
 * Fallback (built-in) registry entries as list results. Routed through `toDataLakeConfig` rather
 * than spread, so the "an actor-less projection cannot carry an editor-only field" invariant holds
 * on this arm too: `PREMIUM_DATA_LAKES` is `JSON.parse`d from env and keeps unknown keys, so a
 * REGISTRY entry (`dl`) carrying a `systemPrompt` field would otherwise be served to every caller.
 * This is why `systemPrompt` below is read ONLY from `overlay` (the admin-write-gated table), never
 * from `dl` - the leak guard is about the untrusted source, not the field name. Fallbacks have no
 * owner and are read-only for everyone, so `canManage` is always false.
 *
 * `canRebuild` and `canManageSettings` DO take an actor, unlike every other field here: both are
 * `ctx.isAdmin` directly, not `resolveCanManageLake` - see `assertLakeRebuildAccess`'s comment for
 * why an org-scoped overlay lake must not let a customer-side org admin pass. This is a
 * deliberate, narrow exception to "actor-less projection"; any field added here under this pattern
 * must repeat the same reasoning.
 *
 * NOT identical to the server-side gate, and deliberately so rather than by oversight: the write
 * path resolves through `resolveFallbackLake`, which applies the lake's ORG PREREQUISITE before its
 * `ctx.isAdmin` bypass, while this flag is `ctx.isAdmin` alone and `listAllDataLakes` applies no org
 * filter to fallbacks. So for an ORG-SCOPED registry lake, a platform admin outside that org sees
 * the affordance and gets a not-found on save. Fail-CLOSED (a lit button that 404s, never an
 * escalation), and unreachable today - no registry entry carries an organizationId and
 * NEXT_PUBLIC_PREMIUM_DATA_LAKES is unset in every stage - but narrow the flag here, not widen the
 * gate, if one is ever added.
 *
 * `groundingMode`, `preferredSystemPromptId` and `systemPrompt` are the exceptions to "no
 * editor-only field for a fallback lake": all three are merged in from the overlay
 * (`fallbackSettingsByLakeId`) and gated on `canManageSettings`, mirroring how `toManageableConfig`
 * gates the same fields on `manageable` - they need to round-trip into the settings modal the same
 * way a DB lake's do. None of the three is the effective value a session/turn actually resolves
 * (that is `resolveFallbackLake`'s job for the first two, and `getDataLakePrompts`'s
 * `isTrustedForInjection` for the third - which independently decides whether THIS stored value is
 * ever injected, org-scoped registry lakes only); this is purely what the editor UI seeds its
 * picker/textarea from. `systemPrompt` is trimmed and blank-as-absent, matching `toManageableConfig`.
 */
const toFallbackConfig = (
  dl: DataLakeConfig,
  ctx: Pick<AccessContext, 'isAdmin'>,
  overlay?: FallbackOverlay
): ManageableDataLakeConfig => ({
  ...toDataLakeConfig(dl),
  canManage: false,
  canRebuild: ctx.isAdmin,
  canManageSettings: ctx.isAdmin,
  // Built-in registry lakes have no creator, so they are never "yours" and carry no owner label.
  isOwn: false,
  ...(ctx.isAdmin && overlay?.groundingMode ? { groundingMode: overlay.groundingMode } : {}),
  ...(ctx.isAdmin && overlay?.preferredSystemPromptId
    ? { preferredSystemPromptId: overlay.preferredSystemPromptId }
    : {}),
  ...(ctx.isAdmin && overlay?.systemPrompt?.trim() ? { systemPrompt: overlay.systemPrompt.trim() } : {}),
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
  const grantedLakeIds = await grantedLakeIdsFor(
    ctx.userId,
    ctx.organizationIds ?? [],
    db.dataLakeAccessGrants,
    includeReaders
  );
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
    .map(dl => toFallbackConfig(dl, ctx));

  return [...dynamicConfigs, ...accessibleFallbacks];
};

/**
 * Lists ALL data lakes (for admin views). No user-tag filtering. Admins may manage every
 * DB lake, so `canManage` is true for those; fallback (built-in) lakes stay read-only for
 * everyone (assertLakeWritable refuses document writes even for admins), so `canManage` is
 * false. `canRebuild` is a separate, narrower flag - see ManageableDataLakeConfig.
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
  const hardcodedFallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id));
  // This is the only list an admin (the only actor toFallbackConfig ever surfaces groundingMode
  // to) ever sees, so the overlay batch is fetched only here - listDataLakes' non-admin callers
  // would never use it.
  const fallbackSettingsByLakeId = await resolveFallbackSettings(
    hardcodedFallbacks.map(dl => dl.id),
    db.fallbackLakeSettings
  );
  const fallbacks = hardcodedFallbacks.map(dl => toFallbackConfig(dl, ctx, fallbackSettingsByLakeId.get(dl.id)));

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
  const grantedLakeIds = await grantedLakeIdsFor(
    ctx.userId,
    ctx.organizationIds ?? [],
    db.dataLakeAccessGrants,
    includeReaders
  );
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
  const grantedLakeIds = await grantedLakeIdsFor(
    ctx.userId,
    ctx.organizationIds ?? [],
    db.dataLakeAccessGrants,
    includeReaders
  );
  const lakes = await db.dataLakes.findAccessible(ctx, { statuses: ['deleted'], includePublic: false, grantedLakeIds });
  const grantsByLake = await grantsByLakeIdFor(lakes, db.dataLakeAccessGrants);
  return redactLakesForActor(lakes, ctx, grantsByLake);
};

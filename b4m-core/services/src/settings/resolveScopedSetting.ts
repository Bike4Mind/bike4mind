import {
  CreditHolderType,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  ScopeRef,
  SettingKey,
  SettingScope,
  SettingScopeLevel,
  SettingValue,
  SETTING_SCOPE_PRECEDENCE,
  settingsMap,
} from '@bike4mind/common';
import { getScopedOverrides, getSettingsByNames, getSettingsValue, scopedOverrideKey } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

/**
 * Scoped settings resolver - the mechanism for epic #1658's governing rule: "every operational value
 * is a lever resolved platform -> org -> owner -> lake, with the narrower scope winning."
 *
 * Platform values live in `AdminSettings` (read via the existing cached accessor); org/owner/lake
 * OVERRIDES live in the `ScopedSetting` overlay. A setting participates only if it opts in via its
 * definition's `scope` metadata (`settableAt`), so a setting with no metadata resolves to exactly its
 * platform value at every scope - which is why every existing platform-only consumer is unchanged.
 *
 * Contract, mirroring `resolveSearchBudgets`: this NEVER throws. Every failure - a missing owner rung,
 * an unparseable override, a scoped-store outage - degrades to the next wider scope (ultimately the
 * platform default) and warns, because the symptom of a silent failure ("a lever the operator set did
 * nothing") is exactly what the epic's "a lever with no consumer is worse than no lever" rule forbids.
 */

export interface ResolvedSetting<T> {
  value: T;
  /** Which rung supplied the winning value - for observability, so a smoke test can see a lever fire. */
  source: SettingScopeLevel;
}

/** The repositories the resolver reads. `scopedSettings` is optional: absent means platform-only. */
export interface ScopedSettingsDb {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
}

function scopeIdForLevel(scope: SettingScope, level: SettingScopeLevel): string | undefined {
  switch (level) {
    case SettingScopeLevel.Lake:
      return scope.lakeId || undefined;
    case SettingScopeLevel.Owner:
      return scope.owner?.id || undefined;
    case SettingScopeLevel.Organization:
      return scope.organizationId || undefined;
    default:
      return undefined;
  }
}

/**
 * The override rungs a key can be resolved from for this scope, narrowest-first. Pure and free of the
 * global `settingsMap` (settableAt/isSensitive are passed in) so the gating logic - which encodes epic
 * decision 7: a chunk-policy setting `settableAt: ['owner']` yields no lake rung, so a lake can never
 * override it - is seam-testable. Empty when the key is platform-only, sensitive, has no store, or the
 * scope carries none of its rungs. Warns (never throws) when an owner/lake-settable key is resolved
 * with no owner in scope: the epic's "owner rung is required" enforced without breaking a platform read.
 */
export function computeCandidateRefs(
  key: string,
  settableAt: readonly SettingScopeLevel[] | undefined,
  isSensitive: boolean,
  scope: SettingScope,
  hasStore: boolean,
  logger?: Logger
): ScopeRef[] {
  if (!settableAt || settableAt.length === 0) return [];
  if (!hasStore) {
    // A scoped-capable setting resolved with a populated scope but no overlay store wired is almost
    // always a caller that forgot to add `scopedSettings` to its ad-hoc `db` object (there is no
    // central aggregate to inherit it from). Silently falling back to platform-only is exactly the
    // no-op lever the epic forbids, so say so when the scope actually carried a settable rung.
    const carriesSettableRung = settableAt.some(level => !!scopeIdForLevel(scope, level));
    if (carriesSettableRung) {
      logger?.warn?.(
        `[scopedSettings] '${key}' is settable at ${settableAt.join('/')} and a matching rung is in scope, ` +
          `but no scoped-override store was provided; resolving platform value only`
      );
    }
    return [];
  }
  if (isSensitive) {
    // Sensitive values live encrypted in AdminSettings and are stored plaintext-only in the overlay;
    // never resolve one through a scoped rung. The lockstep test forbids the registration; this is
    // the runtime backstop so a stray row can never surface a scoped sensitive value.
    logger?.warn?.(`[scopedSettings] refusing to scope sensitive setting '${key}'; using platform value`);
    return [];
  }
  const ownerRequired = settableAt.includes(SettingScopeLevel.Owner) || settableAt.includes(SettingScopeLevel.Lake);
  if (ownerRequired && !scope.owner) {
    logger?.warn?.(
      `[scopedSettings] '${key}' is settable at owner/lake but no owner is in scope; resolving wider scopes only`
    );
  }
  const refs: ScopeRef[] = [];
  for (const level of SETTING_SCOPE_PRECEDENCE) {
    if (!settableAt.includes(level)) continue;
    const id = scopeIdForLevel(scope, level);
    if (id) refs.push({ scopeLevel: level, scopeId: id });
  }
  return refs;
}

/**
 * Pick the winning override for one key from a pre-fetched overrides map: the narrowest rung whose
 * value parses against `schema` wins; an unparseable override is skipped (warn) and resolution falls
 * through. Returns null when no override wins (the caller keeps the platform value). Pure, so the
 * narrower-wins + parse-guard decision is seam-testable without a DB or the global settingsMap.
 */
export function pickOverride(
  key: string,
  refs: ScopeRef[],
  overrides: Map<string, string | null>,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
  logger?: Logger
): { value: unknown; source: SettingScopeLevel } | null {
  for (const ref of refs) {
    const raw = overrides.get(scopedOverrideKey(ref.scopeLevel, ref.scopeId, key));
    if (raw === null || raw === undefined) continue;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger?.warn?.(`[scopedSettings] ignoring unparseable override for '${key}' at ${ref.scopeLevel}:${ref.scopeId}`);
      continue;
    }
    return { value: parsed.data, source: ref.scopeLevel };
  }
  return null;
}

/**
 * Apply a setting's safety-rail clamp to a resolved value ("adjustable does not mean unbounded"). A
 * no-op unless a clamp is declared and the value is numeric - the canonical use is bounding a chunk
 * size to the embedding model's context window (#1662). Pure and exported so the rail is testable
 * independently of which rung produced the value.
 */
export function applyClamp(
  value: unknown,
  scope: SettingScope,
  clamp?: (v: number, s: SettingScope) => number
): unknown {
  if (!clamp || typeof value !== 'number') return value;
  return clamp(value, scope);
}

/**
 * Core resolution: value + winning source for every key, narrower rung winning. One platform read
 * and at most one overlay query cover all keys. Both public APIs derive from this.
 */
async function resolveAll<K extends SettingKey>(
  keys: readonly K[],
  scope: SettingScope,
  db: ScopedSettingsDb,
  logger?: Logger
): Promise<Map<K, ResolvedSetting<SettingValue<K>>>> {
  const result = new Map<K, ResolvedSetting<SettingValue<K>>>();
  if (keys.length === 0) return result;

  // 1. Platform base for every key (existing cached accessor - a warm cache costs no round-trip).
  //    Guarded so the module's "NEVER throws" contract holds even for the platform read: a settings
  //    outage degrades to the per-key coded default (via getSettingsValue below) and warns, rather
  //    than rejecting into any caller that took the contract at its word. `getSettingsByNames` yields
  //    `string | null`; strip the nulls so getSettingsValue sees a genuinely-missing key and falls to
  //    the coded default, instead of coercing null (e.g. z.coerce.number() would turn null into 0).
  const platformRecord: Record<string, string> = {};
  try {
    const raw = await getSettingsByNames(keys as unknown as SettingKey[], db, { logger });
    for (const [name, val] of Object.entries(raw)) {
      if (val !== null && val !== undefined) platformRecord[name] = val;
    }
  } catch (err) {
    logger?.warn?.('[scopedSettings] platform settings read failed; resolving coded defaults', err);
  }

  // 2. Collect every possible (rung, key) override and fetch them in a single overlay query.
  const refsByKey = new Map<K, ScopeRef[]>();
  const allRefs = new Map<string, ScopeRef>();
  const scopedKeys: SettingKey[] = [];
  const hasStore = !!db.scopedSettings;
  for (const key of keys) {
    // `key` is a registered SettingKey, so `settingsMap[key]` is always present - accessed unguarded
    // here and in the resolve loop below (the `scope`/`isSensitive` fields are the optional parts).
    const def = settingsMap[key] as { scope?: { settableAt: readonly SettingScopeLevel[] }; isSensitive?: boolean };
    const refs = computeCandidateRefs(key, def.scope?.settableAt, !!def.isSensitive, scope, hasStore, logger);
    if (refs.length === 0) continue;
    refsByKey.set(key, refs);
    scopedKeys.push(key);
    for (const ref of refs) allRefs.set(`${ref.scopeLevel}:${ref.scopeId}`, ref);
  }

  let overrides = new Map<string, string | null>();
  if (allRefs.size > 0 && db.scopedSettings) {
    try {
      overrides = await getScopedOverrides(
        Array.from(allRefs.values()),
        scopedKeys,
        { scopedSettings: db.scopedSettings },
        { logger }
      );
    } catch (err) {
      logger?.warn?.('[scopedSettings] overlay read failed; resolving platform values only', err);
    }
  }

  // 3. Resolve each key: narrowest valid override wins, else platform. Clamp last (a safety rail that
  //    also applies to the platform value - "adjustable does not mean unbounded").
  for (const key of keys) {
    const def = settingsMap[key];
    let value: unknown = getSettingsValue(key, platformRecord, def.defaultValue as never);
    let source = SettingScopeLevel.Platform;

    const won = pickOverride(key, refsByKey.get(key) ?? [], overrides, def.schema, logger);
    if (won) {
      value = won.value;
      source = won.source;
    }

    const clamp = (def as { scope?: { clamp?: (v: number, s: SettingScope) => number } }).scope?.clamp;
    const clamped = applyClamp(value, scope, clamp);
    if (clamped !== value) {
      logger?.debug?.(`[scopedSettings] clamped '${key}' from ${value} to ${clamped}`);
      value = clamped;
    }

    if (source !== SettingScopeLevel.Platform) {
      logger?.debug?.(`[scopedSettings] '${key}' resolved from ${source} scope`);
    }
    result.set(key, { value: value as SettingValue<K>, source });
  }

  return result;
}

/**
 * Resolve the effective values of several settings for one scope, narrower rung winning. Returned as
 * a mapped type so each key keeps its own value type.
 */
export async function resolveScopedSettingValues<K extends SettingKey>(
  keys: readonly K[],
  scope: SettingScope,
  db: ScopedSettingsDb,
  opts?: { logger?: Logger }
): Promise<{ [P in K]: SettingValue<P> }> {
  const resolved = await resolveAll(keys, scope, db, opts?.logger);
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys) out[key] = resolved.get(key)!.value;
  return out;
}

/** Resolve one setting for a scope, returning the winning value and which rung produced it. */
export async function resolveScopedSetting<K extends SettingKey>(
  key: K,
  scope: SettingScope,
  db: ScopedSettingsDb,
  opts?: { logger?: Logger }
): Promise<ResolvedSetting<SettingValue<K>>> {
  const resolved = await resolveAll([key], scope, db, opts?.logger);
  return resolved.get(key)!;
}

/**
 * Derive the scope of a data lake. The owner rung reflects lake ownership: an org-owned lake
 * (`organizationId` set) is owned by that Organization; otherwise the individual `createdByUserId`.
 * This is the individual-vs-org distinction #1675's cost tiers turn on, computed in exactly one place.
 *
 * Note: for an org-owned lake the org and owner rungs carry the same id (`owner` beats `organization`
 * in {@link SETTING_SCOPE_PRECEDENCE}, so the owner rung wins if both are set). They are distinct rows
 * keyed by `scopeLevel`, so this is not a collision - but an admin surface should write org-wide
 * overrides at ONE rung (the owner rung) rather than both, so intent has a single home.
 */
export function scopeForLake(lake: {
  id?: string;
  createdByUserId: string;
  organizationId?: string | null;
}): SettingScope {
  const orgId = lake.organizationId || undefined; // '' (org-less lake convention) counts as absent
  return {
    organizationId: orgId,
    owner: orgId
      ? { id: orgId, type: CreditHolderType.Organization }
      : { id: lake.createdByUserId, type: CreditHolderType.User },
    lakeId: lake.id,
  };
}

/**
 * Derive the scope for a file's chunk policy (#1662 / epic decision 7): file-owner altitude. The
 * `lakeId` is deliberately OMITTED - chunks are keyed per file and shared across lakes, so a file's
 * policy resolves at its owner, and each lake it belongs to is a separate CONSTRAINT the caller
 * checks, never a narrower-wins override here.
 *
 * Owner derivation MUST match `scopeForLake` (and the rule documented on `SettingOwnerType`): an
 * org-owned file (organizationId set) is owned by that Organization, otherwise by the individual
 * `userId`. If files addressed `owner:<userId>` while org lakes addressed `owner:<orgId>`, an
 * org-wide chunk policy set through the lake path would write a rung the file path never reads - the
 * "lever that does nothing" this scheme exists to prevent.
 */
export function scopeForFileOwner(file: { userId: string; organizationId?: string | null }): SettingScope {
  const orgId = file.organizationId || undefined;
  return {
    organizationId: orgId,
    owner: orgId
      ? { id: orgId, type: CreditHolderType.Organization }
      : { id: file.userId, type: CreditHolderType.User },
  };
}

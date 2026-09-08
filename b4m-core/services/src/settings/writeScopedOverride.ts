import {
  IScopedSettingsRepository,
  ScopeRef,
  SettingKey,
  SettingOwnerType,
  SettingScopeLevel,
  settingsMap,
} from '@bike4mind/common';
import { invalidateScopedSettingsCache } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

/**
 * The scoped-override writer (epic #1658 lane 0 / #1660 follow-on). `resolveScopedSetting.ts` ships
 * read-only and NEVER throws (a read degrades to the next wider scope); this is the write boundary,
 * and it is the opposite contract on purpose - a write is a validated command, not a best-effort
 * read, so an invalid key/scope/value throws before anything reaches the database.
 *
 * The guarantee this module exists to make structural rather than conventional: invalidation cannot
 * be forgotten. `invalidateScopedSettingsCache` already existed but had no caller - every write path
 * was left to a future caller to remember it (exactly the trap the issue that created this file
 * describes). Bundling the DB write and the invalidation in one function means a caller cannot do one
 * without the other; the cross-instance caveat below still applies.
 *
 * Cross-instance staleness bound: invalidation here only clears the CURRENT process's
 * `ScopedSettingsCache`. A written or cleared override is visible on this instance's very next
 * resolve (in-process read-your-writes), but another Lambda execution environment keeps its own copy
 * until its cache entry expires - up to one TTL (5 minutes in prod, 30s in development; see
 * `ScopedSettingsCache`). That bound is accepted for the current single-writer admin assumption; a
 * multi-writer admin surface (epic #1658) should revisit it with a shared cache or a pub/sub
 * invalidation broadcast rather than widening this function's contract.
 */

export interface ScopedOverrideWriteDb {
  scopedSettings: Pick<IScopedSettingsRepository, 'upsertOverride' | 'clearOverride'>;
}

/**
 * Validate and write one override. Throws (does not degrade) when `key` is not settable at
 * `ref.scopeLevel`, is a sensitive setting (sensitive values never live in the plaintext overlay),
 * or `rawValue` fails the setting's own schema - none of those write to the database.
 */
export async function writeScopedOverride<K extends SettingKey>(
  key: K,
  ref: ScopeRef & { ownerType?: SettingOwnerType },
  rawValue: string,
  db: ScopedOverrideWriteDb,
  opts?: { logger?: Logger }
): Promise<void> {
  const def = settingsMap[key] as {
    scope?: { settableAt: readonly SettingScopeLevel[] };
    isSensitive?: boolean;
    schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
  };

  if (!def.scope?.settableAt?.includes(ref.scopeLevel)) {
    throw new Error(`[scopedSettings] '${key}' is not settable at scope level '${ref.scopeLevel}'`);
  }
  if (def.isSensitive) {
    throw new Error(`[scopedSettings] '${key}' is sensitive and cannot be scoped`);
  }
  const parsed = def.schema.safeParse(rawValue);
  if (!parsed.success) {
    throw new Error(`[scopedSettings] value for '${key}' failed validation: ${rawValue}`);
  }
  // ownerType is meaningful (and required, for attribution) only at the owner rung - enforce the
  // biconditional here rather than passing it through, or a caller could leave a stale ownerType on
  // a re-write that omits it (Mongoose drops an `undefined` $set field instead of clearing it).
  if (ref.scopeLevel === SettingScopeLevel.Owner && !ref.ownerType) {
    throw new Error(`[scopedSettings] ownerType is required when writing an owner-scoped override for '${key}'`);
  }
  if (ref.scopeLevel !== SettingScopeLevel.Owner && ref.ownerType) {
    throw new Error(`[scopedSettings] ownerType is only meaningful at the owner scope, not '${ref.scopeLevel}'`);
  }

  await db.scopedSettings.upsertOverride({
    scopeLevel: ref.scopeLevel,
    scopeId: ref.scopeId,
    ownerType: ref.ownerType,
    settingName: key,
    // rawValue, not parsed.data: the overlay stores the raw string (schema.safeParse above is a
    // validation gate, not a normalization step); the resolver re-parses it via pickOverride on read.
    settingValue: rawValue,
  });
  opts?.logger?.debug?.(`[scopedSettings] wrote '${key}' override at ${ref.scopeLevel}:${ref.scopeId}`);
  invalidateScopedSettingsCache({ scopeLevel: ref.scopeLevel, scopeId: ref.scopeId });
}

/** Clear the override at this address, if any. Always invalidates the cache, even on a no-op clear. */
export async function clearScopedOverride<K extends SettingKey>(
  key: K,
  ref: ScopeRef,
  db: ScopedOverrideWriteDb,
  opts?: { logger?: Logger }
): Promise<void> {
  await db.scopedSettings.clearOverride({ scopeLevel: ref.scopeLevel, scopeId: ref.scopeId, settingName: key });
  opts?.logger?.debug?.(`[scopedSettings] cleared '${key}' override at ${ref.scopeLevel}:${ref.scopeId}`);
  invalidateScopedSettingsCache({ scopeLevel: ref.scopeLevel, scopeId: ref.scopeId });
}

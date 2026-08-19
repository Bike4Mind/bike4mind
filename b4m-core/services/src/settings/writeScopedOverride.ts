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
 * The one guarantee this module exists to make structural rather than conventional: a write can
 * never leave the cache stale. `invalidateScopedSettingsCache` already existed but had no caller -
 * every write path was left to a future caller to remember it (exactly the trap the issue that
 * created this file describes). Bundling the DB write and the invalidation in one function means a
 * caller cannot do one without the other.
 *
 * Cross-instance staleness bound: invalidation here only clears the CURRENT process's
 * `ScopedSettingsCache`. A written or cleared override is visible on this instance's very next
 * resolve (in-process read-your-writes), but another instance/container keeps its own copy until its
 * cache entry expires - up to one TTL (5 minutes in prod, 30s in development; see
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

  await db.scopedSettings.upsertOverride({
    scopeLevel: ref.scopeLevel,
    scopeId: ref.scopeId,
    ownerType: ref.ownerType,
    settingName: key,
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

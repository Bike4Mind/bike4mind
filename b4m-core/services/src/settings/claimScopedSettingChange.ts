import {
  DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_DEFAULT,
  DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_MAX,
  IAdminSettingsRepository,
  ICacheRepository,
  IScopedSettingsRepository,
  ScopeRef,
  SettingKey,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { parseNumericSetting, type NumericSettingSpec } from './parseNumericSetting';

const HOUR_MS = 3_600_000;

/**
 * Scoped settings whose every change is expensive enough to rate-limit per scope owner, mapped to
 * the admin setting holding the minimum hours between changes. A new `DefaultChunkSize` misses the
 * embedding cache for every file it re-chunks, so each change re-embeds the owner's corpus.
 */
const CHANGE_COOLDOWNS: Partial<Record<SettingKey, NumericSettingSpec & { key: SettingKey }>> = {
  DefaultChunkSize: {
    key: 'DefaultChunkSizeChangeCooldownHours',
    fallback: DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_DEFAULT,
    min: 0,
    max: DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_MAX,
  },
};

export interface ScopedSettingCooldownDb {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  cache: Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow' | 'deleteByKey'>;
  scopedSettings: Pick<IScopedSettingsRepository, 'findOverrides'>;
}

/**
 * The message keeps the `[scopedSettings]` prefix so the admin route maps it to a 400 the same way
 * it maps the writer's other rejections (see `apps/client/pages/api/admin/scoped-settings`).
 */
export class ScopedSettingChangeCooldownError extends Error {
  readonly nextChangeAt: Date;

  constructor(key: SettingKey, ref: ScopeRef, cooldownHours: number, nextChangeAt: Date) {
    super(
      `[scopedSettings] '${key}' at ${ref.scopeLevel}:${ref.scopeId} can change at most once every ` +
        `${cooldownHours}h; the next change is allowed after ${nextChangeAt.toISOString()}`
    );
    this.name = 'ScopedSettingChangeCooldownError';
    this.nextChangeAt = nextChangeAt;
  }
}

/** A granted change. `release` gives the slot back when the write it was claimed for failed. */
export interface ScopedSettingChangeClaim {
  release: () => Promise<void>;
}

export const scopedSettingChangeCacheKey = (key: SettingKey, ref: ScopeRef) =>
  `scopedSettingChange:${key}:${ref.scopeLevel}:${ref.scopeId}`;

export function hasScopedSettingChangeCooldown(key: SettingKey): boolean {
  return CHANGE_COOLDOWNS[key] !== undefined;
}

/**
 * Claim the right to change `key` at `ref` to `nextValue` (`null` for a clear), or throw
 * {@link ScopedSettingChangeCooldownError}. Returns `null` when nothing is claimed: the key has no
 * cooldown, the cooldown is set to 0, or the write would not change the stored value. The claim is
 * an atomic cache counter, so two concurrent writes to one address cannot both pass.
 *
 * Throws when the key has a cooldown and `db` is missing: a writer that forgot to pass the
 * cooldown dependencies must fail loudly rather than write unthrottled.
 */
export async function claimScopedSettingChange(
  key: SettingKey,
  ref: ScopeRef,
  nextValue: string | null,
  db: ScopedSettingCooldownDb | undefined,
  opts?: { logger?: Logger }
): Promise<ScopedSettingChangeClaim | null> {
  const spec = CHANGE_COOLDOWNS[key];
  if (!spec) return null;
  if (!db) {
    throw new Error(`[scopedSettings] '${key}' has a change cooldown; the writer must pass its dependencies`);
  }

  const values = await getSettingsByNames([spec.key], db, { logger: opts?.logger });
  const cooldownHours = parseNumericSetting(values[spec.key], spec, opts?.logger);
  if (cooldownHours <= 0) return null;

  const [current] = await db.scopedSettings.findOverrides([ref], [key]);
  if ((current?.settingValue ?? null) === nextValue) return null;

  const cacheKey = scopedSettingChangeCacheKey(key, ref);
  const window = await db.cache.tryAddWithinLimitFixedWindow(cacheKey, 1, 1, cooldownHours * HOUR_MS);
  if (!window.success) throw new ScopedSettingChangeCooldownError(key, ref, cooldownHours, window.expiresAt);

  return {
    release: async () => {
      await db.cache.deleteByKey(cacheKey);
    },
  };
}

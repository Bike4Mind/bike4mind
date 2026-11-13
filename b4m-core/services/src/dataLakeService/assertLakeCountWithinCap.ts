import type { IAdminSettingsRepository, IDataLakeRepository } from '@bike4mind/common';
import {
  DATA_LAKE_LIMIT_REACHED_CODE,
  DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT,
  DATA_LAKE_MAX_LAKES_PER_USER_MAX,
} from '@bike4mind/common';
import { ForbiddenError, getSettingsByNames } from '@bike4mind/utils';

const SETTING_KEY = 'dataLakeMaxLakesPerUser';

export const lakeLimitReachedMessage = (cap: number): string =>
  `You have reached the limit of ${cap} data ${cap === 1 ? 'lake' : 'lakes'} per account. ` +
  'Archived lakes count toward it; delete a lake you no longer need, then create the new one.';

/**
 * The configured cap, or 0 when it is off. An absent or unreadable stored value falls back to the
 * coded default (off).
 */
export async function resolveMaxLakesPerUser(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<number> {
  // Uncached: lake creation is rare, and an admin lowering the cap expects it to bite at once.
  const values = await getSettingsByNames([SETTING_KEY], db, { skipCache: true });
  const raw = values[SETTING_KEY];
  if (raw === null || raw === undefined || String(raw) === '') return DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT;
  const parsed = Number(String(raw));
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger?.warn(`[lakeCap] unusable ${SETTING_KEY}=${JSON.stringify(raw)}; using the default`);
    return DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT;
  }
  return Math.min(parsed, DATA_LAKE_MAX_LAKES_PER_USER_MAX);
}

/**
 * Refuses a create once the user already has `dataLakeMaxLakesPerUser` lakes that still count (see
 * LAKE_UNCOUNTED_STATUSES). Counted by CREATOR, so a lake made in an org counts for the person
 * who made it.
 */
export async function assertLakeCountWithinCap(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    dataLakes: Pick<IDataLakeRepository, 'countCountedCreatedBy'>;
  },
  userId: string,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  const cap = await resolveMaxLakesPerUser(db, logger);
  if (cap === 0) return;
  const existing = await db.dataLakes.countCountedCreatedBy(userId);
  if (existing < cap) return;
  throw new ForbiddenError(lakeLimitReachedMessage(cap), { code: DATA_LAKE_LIMIT_REACHED_CODE, limit: cap });
}

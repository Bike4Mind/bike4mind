import { IMAGE_MODERATION_LIMIT_FREE_PER_DAY, type SettingKey } from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { Logger } from '@bike4mind/observability';
import { resolveUserRateTier, type RateTierUser, type UserRateTier } from '@server/utils/userRateTier';

/**
 * Per-user daily allowance of moderation detector calls for uploaded images, spent by
 * scanUploadedObject (moderationScan.ts): one per still image, one per sampled frame of an animation.
 * Same tier shape as the hourly upload allowance in server/files/fileUploadBudget.ts.
 */

// ms.
export const IMAGE_MODERATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const BUCKET = 'image-moderation';

const LIMIT_SETTING = {
  free: 'imageModerationLimitFreePerDay',
  shadow: 'imageModerationLimitFreePerDay',
  basic: 'imageModerationLimitPaidPerDay',
  pro: 'imageModerationLimitPaidPerDay',
} as const satisfies Record<Exclude<UserRateTier, 'bypass'>, SettingKey>;

async function resolveLimit(user: RateTierUser): Promise<number> {
  if (isDevelopment()) return Infinity;
  try {
    // No request on the S3-landing path, so subscriptions are read for the user directly.
    const tier = await resolveUserRateTier(user);
    if (tier === 'bypass') return Infinity;
    const settingKey = LIMIT_SETTING[tier];
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: [settingKey] });
    // `??` keeps an explicit 0, which holds every uploaded image for the tier.
    return getSettingsValue(settingKey, settings) ?? IMAGE_MODERATION_LIMIT_FREE_PER_DAY;
  } catch (error) {
    Logger.globalInstance.warn('[imageModerationBudget] limit resolution failed; applying the free allowance', {
      error,
    });
    return IMAGE_MODERATION_LIMIT_FREE_PER_DAY;
  }
}

/** Spend `calls` from the user's daily allowance, all or nothing. False when they do not fit. */
export async function reserveImageModerationCalls(user: RateTierUser, calls: number): Promise<boolean> {
  if (calls <= 0) return true;
  const limit = await resolveLimit(user);
  if (limit === Infinity) return true;
  const { success } = await cacheRepository.tryAddWithinLimitFixedWindow(
    `rate-limit:${user.id}:${BUCKET}`,
    calls,
    limit,
    IMAGE_MODERATION_WINDOW_MS
  );
  return success;
}

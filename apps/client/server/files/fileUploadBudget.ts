import {
  FILE_UPLOAD_LIMIT_FREE_PER_HOUR,
  TooManyRequestsError,
  UnauthorizedError,
  type SettingKey,
} from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { Logger } from '@bike4mind/observability';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { resolveUserRateTier, type RateTierUser, type UserRateTier } from '@server/utils/userRateTier';

/**
 * Per-user hourly allowance of files entering the upload pipeline, counted per FILE (a 100-file batch
 * spends 100) in one bucket shared by every door into the pipeline: single and batch presign (including
 * POST /api/v1/files), direct upload, URL import, generated-image copy, re-chunk and reprocess. Each
 * admitted file costs moderation, extraction and embedding downstream, so a per-request limit alone
 * would let a batch door multiply it. Callers spend only after their own admission gates, so a refused
 * request costs nothing.
 */

// ms. Long enough that a bulk data-lake upload fits in one window at the paid default.
export const FILE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;
export const FILE_UPLOAD_LIMITED = 'file_upload_rate_limited';

const BUCKET = 'file-upload';

const LIMIT_SETTING = {
  free: 'fileUploadLimitFreePerHour',
  shadow: 'fileUploadLimitFreePerHour',
  basic: 'fileUploadLimitPaidPerHour',
  pro: 'fileUploadLimitPaidPerHour',
} as const satisfies Record<Exclude<UserRateTier, 'bypass'>, SettingKey>;

async function resolveLimit(user: RateTierUser, req: ActiveSubscriptionsRequest): Promise<number> {
  if (isDevelopment()) return Infinity;
  try {
    const tier = await resolveUserRateTier(user, req);
    if (tier === 'bypass') return Infinity;
    const settingKey = LIMIT_SETTING[tier];
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: [settingKey] });
    // `??` keeps an explicit 0, which blocks uploads for the tier.
    return getSettingsValue(settingKey, settings) ?? FILE_UPLOAD_LIMIT_FREE_PER_HOUR;
  } catch (error) {
    // The free allowance, never 0 or no cap: an outage must neither block uploads nor lift the limit.
    Logger.globalInstance.warn('[fileUploadBudget] limit resolution failed; applying the free allowance', {
      error,
    });
    return FILE_UPLOAD_LIMIT_FREE_PER_HOUR;
  }
}

/**
 * Spend `fileCount` files from the caller's hourly allowance, all or nothing. Throws a 429
 * (errorHandler adds `Retry-After`) when the files do not fit; nothing is spent then.
 */
export async function consumeFileUploadBudget(req: ActiveSubscriptionsRequest, fileCount: number): Promise<void> {
  if (fileCount <= 0) return;
  // Every door runs behind auth, so a missing user is a can't-happen; refuse rather than skip the cap.
  const { user } = req;
  if (!user) throw new UnauthorizedError('Sign in to upload files');
  const limit = await resolveLimit(user, req);
  if (limit === Infinity) return;

  const { success, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
    `rate-limit:${user.id}:${BUCKET}`,
    fileCount,
    limit,
    FILE_UPLOAD_WINDOW_MS
  );
  if (success) return;

  // A request larger than the whole allowance can never fit, so waiting would not help.
  if (fileCount > limit && limit > 0) {
    throw new TooManyRequestsError(
      `This upload has ${fileCount} files, more than the ${limit} files per hour allowed. Upload fewer files at a time.`,
      { code: FILE_UPLOAD_LIMITED, details: { limit, requested: fileCount } }
    );
  }
  const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  throw new TooManyRequestsError(
    limit > 0
      ? `Upload limit reached (${limit} files per hour). Try again in ${Math.ceil(retryAfter / 60)} minutes.`
      : 'File uploads are currently blocked for your account.',
    { code: FILE_UPLOAD_LIMITED, retryAfter, details: { limit, requested: fileCount } }
  );
}

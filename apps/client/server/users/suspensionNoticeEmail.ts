import { SUSPENSION_REASONS, WEBSITE_URL, getWebsiteUrl, toSuspensionReasonCategory } from '@bike4mind/common';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import mailer from '@bike4mind/server-utils/utils/mailer/index';
import { configuredSupportEmail } from '@server/auth/blockedSignIn';

type WarnLogger = { warn(msg: string, meta: unknown): void };

/**
 * The optional suspension email, sent only when `suspensionNoticeEmailEnabled` is on (off by default).
 * The in-app, sign-in and API notices are the primary channel and do not depend on this. Call after
 * the suspension commits; never throws.
 */
export async function emailSuspensionNoticeIfEnabled(
  userId: string,
  storedCategory: unknown,
  logger?: WarnLogger
): Promise<void> {
  try {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['suspensionNoticeEmailEnabled'] }
    );
    if (!getSettingsValue('suspensionNoticeEmailEnabled', settings, false)) return;
    const category = toSuspensionReasonCategory(storedCategory);
    await userService.notifyAccountSuspended(
      {
        userId,
        category,
        supportEmail: configuredSupportEmail(),
        policyUrl: WEBSITE_URL ? getWebsiteUrl(SUSPENSION_REASONS[category].policy.slug) : undefined,
      },
      { db: { users: userRepository }, mailer, logger }
    );
  } catch (error) {
    logger?.warn('[suspension] notice email skipped after an error', { userId, error: String(error) });
  }
}

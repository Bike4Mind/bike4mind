import {
  SIGNUP_GRANT_KEYS,
  SIGNUP_GRANT_PROTECTION_KEYS,
  SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE,
  signupGrantProtectionGap,
  type IAdminSettingsRepository,
} from '@bike4mind/common';

type AlarmLogger = {
  warn?: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

/**
 * Logs the message the signup alarm counts when a grant is about to be released while a large grant is
 * configured and a protection is still off. Never throws: a failed read must not block the grant.
 */
export async function logUnprotectedSignupGrant(
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames'>,
  logger: AlarmLogger
): Promise<void> {
  try {
    const rows = await adminSettings.findBySettingNames([...SIGNUP_GRANT_KEYS, ...SIGNUP_GRANT_PROTECTION_KEYS]);
    const gap = signupGrantProtectionGap(Object.fromEntries(rows.map(row => [row.settingName, row.settingValue])));
    if (gap) logger.warn?.(SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE, gap);
  } catch (error) {
    logger.error('signup-grant-protection-check-failed', { error });
  }
}

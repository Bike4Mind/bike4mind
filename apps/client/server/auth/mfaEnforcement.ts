import type { IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

/**
 * Schema-aware read: the stored value may be a boolean or a legacy string. Uncached by default:
 * sign-in and MFA disable must bind every instance the moment enforcement turns on, not after
 * the settings cache expires. The per-request gate opts into the cache (see isMfaEnrollmentOwed).
 */
export async function readEnforceMfa({ skipCache = true }: { skipCache?: boolean } = {}): Promise<boolean> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache, names: ['enforceMFA'] }
  );
  return getSettingsValue('enforceMFA', settings) === true;
}

/**
 * True when the admin enforces MFA and this user has none enrolled: the same decision the
 * sign-in gate (resolveSecondFactor) makes, applied to sessions that already exist. Checked on
 * every authenticated request by the REST auth middleware (auth.ts), the CLI verifier
 * (cli/auth.ts) and the WS verifier (websocket/verifyWsAccessToken.ts); keep them in sync.
 *
 * Reads the setting through the cache because it runs per request. An enrolled user never
 * reaches the read, and a toggle reaches other instances within one settings-cache TTL.
 */
export async function isMfaEnrollmentOwed(user: IUserDocument): Promise<boolean> {
  if (mfaService.userHasMFAConfigured(user)) return false;
  return readEnforceMfa({ skipCache: false });
}

export const MFA_ENROLLMENT_REQUIRED_MESSAGE = 'MFA enrollment required.';

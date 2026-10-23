import { API_KEY_TRUST_REQUIRED_ERROR_CODE, IAdminSettingsRepository, IUser, settingsMap } from '@bike4mind/common';
import { ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ApiKeyTrustSettings = {
  gateEnabled: boolean;
  minAccountAgeDays: number;
  maxActiveKeysUntrusted: number;
  untrustedRateLimitPerMinute: number;
};

export const loadApiKeyTrustSettings = async (db: {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
}): Promise<ApiKeyTrustSettings> => {
  const settings = await getSettingsMap(db, {
    names: [
      'apiKeyTrustGateEnabled',
      'apiKeyMinAccountAgeDays',
      'maxActiveKeysUntrusted',
      'apiKeyUntrustedRateLimitPerMin',
    ],
  });
  // Each schema prefaults to its declared default, so parsing undefined yields that default.
  return {
    gateEnabled: getSettingsValue(
      'apiKeyTrustGateEnabled',
      settings,
      settingsMap.apiKeyTrustGateEnabled.schema.parse(undefined)
    ),
    minAccountAgeDays: getSettingsValue(
      'apiKeyMinAccountAgeDays',
      settings,
      settingsMap.apiKeyMinAccountAgeDays.schema.parse(undefined)
    ),
    maxActiveKeysUntrusted: getSettingsValue(
      'maxActiveKeysUntrusted',
      settings,
      settingsMap.maxActiveKeysUntrusted.schema.parse(undefined)
    ),
    untrustedRateLimitPerMinute: getSettingsValue(
      'apiKeyUntrustedRateLimitPerMin',
      settings,
      settingsMap.apiKeyUntrustedRateLimitPerMin.schema.parse(undefined)
    ),
  };
};

// createdAt comes from mongoose timestamps and is not on IUser.
export type ApiKeyTrustSubject = Pick<
  IUser,
  'isAdmin' | 'emailVerified' | 'apiKeyTrustApproved' | 'lastCreditsPurchasedAt'
> & {
  createdAt?: Date | string | null;
};

/**
 * How one mint stands with the trust gate. createUserApiKey requires every caller to state
 * one, so a new creation path cannot silently skip the gate.
 * - `exempt`: the caller already authorized the mint on the user's behalf (an admin minting).
 * - `trusted`: the account passes, or the gate is off.
 * - `untrusted`: `email_unverified` may not mint at all; `not_yet_trusted` may hold up to
 *   `maxActiveKeys` active keys until `trustedAfter` or a purchase / admin approval.
 */
export type ApiKeyTrustAssessment =
  | { status: 'exempt' }
  | { status: 'trusted' }
  | { status: 'untrusted'; reason: 'email_unverified' }
  | { status: 'untrusted'; reason: 'not_yet_trusted'; maxActiveKeys: number; trustedAfter: Date };

export type UntrustedApiKeyAssessment = Extract<ApiKeyTrustAssessment, { status: 'untrusted' }>;

/**
 * Trusted = platform admin, or emailVerified AND (purchase or active plan OR account age >= minAccountAgeDays OR
 * admin-approved). `hasActivePlan` is lazy because it is the only check that hits the database,
 * and the cheap user-field checks settle most accounts first.
 */
export const assessApiKeyTrust = async (
  user: ApiKeyTrustSubject,
  options: { settings: ApiKeyTrustSettings; hasActivePlan: () => Promise<boolean>; now?: Date }
): Promise<ApiKeyTrustAssessment> => {
  const { settings, hasActivePlan, now = new Date() } = options;
  if (!settings.gateEnabled || user.isAdmin) return { status: 'trusted' };
  if (!user.emailVerified) return { status: 'untrusted', reason: 'email_unverified' };
  if (user.apiKeyTrustApproved || user.lastCreditsPurchasedAt) return { status: 'trusted' };

  // A missing createdAt predates mongoose timestamps, so the account is old.
  const createdAt = user.createdAt ? new Date(user.createdAt) : null;
  if (!createdAt) return { status: 'trusted' };
  const trustedAfter = new Date(createdAt.getTime() + settings.minAccountAgeDays * MS_PER_DAY);
  if (now >= trustedAfter) return { status: 'trusted' };

  if (await hasActivePlan()) return { status: 'trusted' };
  return {
    status: 'untrusted',
    reason: 'not_yet_trusted',
    maxActiveKeys: settings.maxActiveKeysUntrusted,
    trustedAfter,
  };
};

/** User-facing explanation naming what would unlock key creation. */
export const describeApiKeyTrustRequirement = (assessment: UntrustedApiKeyAssessment): string => {
  if (assessment.reason === 'email_unverified') {
    return 'Verify your email address to create API keys.';
  }
  const unlock = `purchase credits or a plan, wait until ${assessment.trustedAfter.toISOString().slice(0, 10)}, or contact support`;
  if (assessment.maxActiveKeys <= 0) {
    return `New accounts cannot create API keys yet. To unlock them, ${unlock}.`;
  }
  const plural = assessment.maxActiveKeys === 1 ? '' : 's';
  return `New accounts may hold ${assessment.maxActiveKeys} active API key${plural}. To create more, ${unlock}.`;
};

/** 403 tagged `api_key_trust_required`; the reason fields let a client render its own copy. */
export const apiKeyTrustRequiredError = (assessment: UntrustedApiKeyAssessment): ForbiddenError =>
  new ForbiddenError(describeApiKeyTrustRequirement(assessment), {
    errorCode: API_KEY_TRUST_REQUIRED_ERROR_CODE,
    trustReason: assessment.reason,
    ...(assessment.reason === 'not_yet_trusted' && {
      maxActiveKeys: assessment.maxActiveKeys,
      trustedAfter: assessment.trustedAfter.toISOString(),
    }),
  });

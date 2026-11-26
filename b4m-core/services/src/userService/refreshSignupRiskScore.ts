import {
  emailDomainOf,
  SignupRiskScoringSchema,
  type IAdminSettingsRepository,
  type IUsageEventRepository,
  type IUserApiKeyRepository,
  type IUserRepository,
  type SignupProtectionRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isAdminBlockedEmailDomain, isDisposableEmail } from './disposableEmail';
import { isInSignupBurst, signupDomain } from './signupBurstDetector';
import { normalizeRegistrableDomain } from './signupClusterKeys';
import { isSignupGrantHeldForReview } from './signupRisk';
import { scoreSignupRisk } from './signupRiskScore';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The email host when it sits below its registrable domain (`a.example.com`, not `example.com`), else null. */
export function emailSubdomainHost(email: string): string | null {
  const host = emailDomainOf(email)?.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return null;
  const registrable = normalizeRegistrableDomain(host);
  return registrable && host !== registrable && host.endsWith(`.${registrable}`) ? host : null;
}

export interface RefreshSignupRiskScoreAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'setRiskScore' | 'countSignupsOnEmailHost'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'findFirstCreatedAtByUserId'>;
    usageEvents: Pick<IUsageEventRepository, 'creditsSpentByUser'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames' | 'findBySettingName'>;
    signupDomainReviews: Pick<SignupProtectionRepository, 'findReview'>;
  };
  logger: Pick<Logger, 'warn'>;
  now?: Date;
}

/**
 * Gathers what is known about a user, scores it (scoreSignupRisk) and stores the result. Run on
 * email verification and on API key creation. Never scheduled: it can move none to pending, which
 * holds AI access (signupRiskSweep refreshes the shadow-only risk evidence instead).
 * Never throws: none of those callers should fail because scoring did, so a failure logs at warn.
 */
export async function refreshSignupRiskScore(
  userId: string,
  { db, logger, now = new Date() }: RefreshSignupRiskScoreAdapters
): Promise<void> {
  try {
    const user = await db.users.findById(userId);
    if (!user) return;
    const signedUpAt = new Date(user.createdAt);
    const email = user.email ?? '';
    const domain = email ? signupDomain(email) : null;
    const subdomainHost = email ? emailSubdomainHost(email) : null;

    const [settings, firstKeyAt, creditsSpentFirst24h, adminBlocked, domainReview] = await Promise.all([
      getSettingsMap({ adminSettings: db.adminSettings }),
      db.userApiKeys.findFirstCreatedAtByUserId(user.id),
      db.usageEvents.creditsSpentByUser(user.id, signedUpAt, new Date(signedUpAt.getTime() + DAY_MS)),
      email ? isAdminBlockedEmailDomain(email, { adminSettings: db.adminSettings }) : false,
      domain ? db.signupDomainReviews.findReview(domain) : null,
    ]);
    const scoring = getSettingsValue('signupRiskScoring', settings, SignupRiskScoringSchema.parse({}));
    const windowMs = scoring.emailSubdomainWindowHours * HOUR_MS;
    const subdomainSignups = subdomainHost
      ? await db.users.countSignupsOnEmailHost(
          subdomainHost,
          new Date(signedUpAt.getTime() - windowMs),
          new Date(signedUpAt.getTime() + windowMs)
        )
      : null;

    const { score, signals, needsReview } = scoreSignupRisk(
      {
        email,
        // The disposable list counts here even where blockDisposableEmails is off: that toggle
        // exists to work around a false positive in the list, which a weighted score tolerates.
        riskyDomain: email ? isDisposableEmail(email) || adminBlocked : null,
        burstCohort: domain
          ? !!domainReview && isInSignupBurst(domainReview, { id: user.id, createdAt: signedUpAt })
          : null,
        isDatacenter: user.signupMeta?.isDatacenter ?? null,
        wafAnonIp: user.signupMeta?.wafAnonIp ?? null,
        wafBotSignal: user.signupMeta?.wafBotSignal ?? null,
        minutesToFirstApiKey: firstKeyAt ? (firstKeyAt.getTime() - signedUpAt.getTime()) / MINUTE_MS : null,
        creditsSpentFirst24h,
        emailSubdomainSignups: subdomainSignups?.total ?? null,
        bannedEmailSubdomainSignups: subdomainSignups?.banned ?? null,
      },
      scoring
    );
    await db.users.setRiskScore(user.id, {
      score,
      signals,
      computedAt: now,
      // A grant held by the signup grant policy is released by approving it here, whatever this score says.
      reviewState: needsReview || isSignupGrantHeldForReview(user) ? 'pending' : 'none',
    });
  } catch (error) {
    logger.warn('Signup risk score refresh failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

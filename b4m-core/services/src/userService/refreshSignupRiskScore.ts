import {
  SignupRiskScoringSchema,
  type IAdminSettingsRepository,
  type IUsageEventRepository,
  type IUserApiKeyRepository,
  type IUserRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isAdminBlockedEmailDomain, isDisposableEmail } from './disposableEmail';
import { isSignupGrantHeldForReview } from './signupRisk';
import { scoreSignupRisk } from './signupRiskScore';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface RefreshSignupRiskScoreAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'setRiskScore'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'findFirstCreatedAtByUserId'>;
    usageEvents: Pick<IUsageEventRepository, 'creditsSpentByUser'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames' | 'findBySettingName'>;
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

    const [settings, firstKeyAt, creditsSpentFirst24h, adminBlocked] = await Promise.all([
      getSettingsMap({ adminSettings: db.adminSettings }),
      db.userApiKeys.findFirstCreatedAtByUserId(user.id),
      db.usageEvents.creditsSpentByUser(user.id, signedUpAt, new Date(signedUpAt.getTime() + DAY_MS)),
      email ? isAdminBlockedEmailDomain(email, { adminSettings: db.adminSettings }) : false,
    ]);
    const scoring = getSettingsValue('signupRiskScoring', settings, SignupRiskScoringSchema.parse({}));

    const { score, signals, needsReview } = scoreSignupRisk(
      {
        email,
        // The disposable list counts here even where blockDisposableEmails is off: that toggle
        // exists to work around a false positive in the list, which a weighted score tolerates.
        riskyDomain: email ? isDisposableEmail(email) || adminBlocked : null,
        // No producer yet; filled in once burst detection stores cohort membership.
        burstCohort: null,
        isDatacenter: user.signupMeta?.isDatacenter ?? null,
        minutesToFirstApiKey: firstKeyAt ? (firstKeyAt.getTime() - signedUpAt.getTime()) / MINUTE_MS : null,
        creditsSpentFirst24h,
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

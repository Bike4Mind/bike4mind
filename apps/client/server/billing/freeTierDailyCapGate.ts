import type { IUserDocument, IUsageEventRepository } from '@bike4mind/common';
import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE, TooManyRequestsError } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

import { resolveUserRateTier } from '@server/utils/userRateTier';

const DAY_MS = 24 * 60 * 60 * 1000;

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** True for the 429 `checkFreeTierDailySpendCap` throws, so a caller can answer it instead of failing the turn. */
export function isFreeTierDailyCapError(error: unknown): error is TooManyRequestsError {
  return (
    error instanceof TooManyRequestsError && error.additionalInfo?.errorCode === DAILY_FREE_LIMIT_REACHED_ERROR_CODE
  );
}

/**
 * Throw a 429 `daily_free_limit_reached` if the user is on the free tier and
 * has already spent their daily credit allowance. No-op when enforceCredits is
 * off, the user is on a paid/bypass tier, or no cap is configured.
 *
 * Call this AFTER `assertAiAccessAllowed` and BEFORE the credit hold, so a
 * capped user never produces a dangling hold that the sweep has to clean up.
 */
export async function checkFreeTierDailySpendCap({
  user,
  usageEventRepository,
  logger,
}: {
  user: IUserDocument;
  usageEventRepository: IUsageEventRepository;
  logger: ILogger;
}): Promise<void> {
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });

    const enforceCredits = getSettingsValue('enforceCredits', settings) === true;
    if (!enforceCredits) return;

    const tier = await resolveUserRateTier(user);
    if (tier !== 'free') return;

    const steadyCap = getSettingsValue('freeTierDailySpendCapCredits', settings) ?? 0;
    if (steadyCap <= 0) return;

    const now = new Date();
    // A legacy user without createdAt predates the ramp, so it gets the steady-state cap.
    const accountAgeMs = user.createdAt ? now.getTime() - new Date(user.createdAt).getTime() : Infinity;
    let cap: number;
    if (accountAgeMs < DAY_MS) {
      cap = getSettingsValue('freeTierDay1SpendCapCredits', settings) ?? steadyCap;
      if (cap <= 0) cap = steadyCap;
    } else if (accountAgeMs < 7 * DAY_MS) {
      cap = getSettingsValue('freeTierDays2To7SpendCapCredits', settings) ?? steadyCap;
      if (cap <= 0) cap = steadyCap;
    } else {
      cap = steadyCap;
    }

    const startOfDay = utcMidnight(now);
    const todaySpend = await usageEventRepository.findDailySpendByUser(user.id, startOfDay);
    if (todaySpend >= cap) {
      // Seconds until the next UTC midnight; becomes the Retry-After header.
      const retryAfter = Math.ceil((startOfDay.getTime() + DAY_MS - now.getTime()) / 1000);
      throw new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
        errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
        retryAfter,
        spentToday: todaySpend,
        dailyCap: cap,
      });
    }
  } catch (err) {
    if (err instanceof TooManyRequestsError) throw err;
    // Fail open: a transient DB or settings read failure must not block the user.
    logger.warn('[freeTierDailyCapGate] cap check failed; allowing request', { error: err });
  }
}

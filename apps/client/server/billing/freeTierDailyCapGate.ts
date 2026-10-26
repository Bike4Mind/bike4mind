import type { IUserDocument, IUsageEventRepository } from '@bike4mind/common';
import { TooManyRequestsError } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

import { resolveUserRateTier } from '@server/utils/userRateTier';

/** 24 hours in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Return UTC midnight for the current day (start of today). */
function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

    const accountAgeMs = Date.now() - user.createdAt.getTime();
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

    const todaySpend = await usageEventRepository.findDailySpendByUser(user.id, utcMidnightToday());
    if (todaySpend >= cap) {
      throw new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
        code: 'daily_free_limit_reached',
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

import type { IUserDocument } from '@bike4mind/common';
import { DAILY_FREE_LIMIT_REACHED_ERROR_CODE, TooManyRequestsError } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { persistedIsAdmin } from '@server/auth/apiKeyAdminScope';

interface IUserRepository {
  findById(id: string): Promise<IUserDocument | null>;
}

type DailySpendRepository = {
  findDailySpendByUser(userId: string, since: Date): Promise<number>;
};

type CapCheckInput =
  // Caller already holds the resolved user (e.g. request middleware) - no extra DB read.
  | { user: IUserDocument; userId?: never; userRepository?: never }
  // Caller only has a user ID - the lookup is deferred until after the enforceCredits gate.
  | { userId: string; userRepository: IUserRepository; user?: never };

/** 24 hours in milliseconds. */
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
  usageEventRepository,
  logger,
  req,
  billingOrganizationId,
  ...input
}: CapCheckInput & {
  usageEventRepository: DailySpendRepository;
  logger: ILogger;
  /** Request memo for the tier lookup, so it reuses the request's subscription reads. */
  req?: ActiveSubscriptionsRequest;
  /** When set, the turn bills an org rather than the user personally; the personal cap does not apply. */
  billingOrganizationId?: string | null;
}): Promise<void> {
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });

    const enforceCredits = getSettingsValue('enforceCredits', settings) === true;
    if (!enforceCredits) return;

    // Org-billed turns are settled against the org's shared pool, not the user's personal credits.
    if (billingOrganizationId) return;

    const steadyCap = getSettingsValue('freeTierDailySpendCapCredits', settings) ?? 0;
    if (steadyCap <= 0) return;

    // Reuse a resolved user; ID-only callers defer their lookup until enforcement is enabled.
    const user = 'user' in input && input.user ? input.user : await input.userRepository.findById(input.userId);
    if (!user) return;
    // This is a billing exemption for the owner, independent of the key's permission scopes.
    if (persistedIsAdmin(user)) return;

    // Dynamic: userRateTier pulls in the Subscription model at module init, which crashes route tests
    // that mock @bike4mind/database but never reach the cap check.
    const { resolveUserRateTier } = await import('@server/utils/userRateTier');
    // A degraded org-seat lookup cannot establish that the caller is free. Let the error
    // reach the fail-open handler instead of denying a paid seat's personal turn.
    // Without `throttle`: a restricted user keeps the cap of their subscription tier.
    const tier = await resolveUserRateTier({ id: user.id, isAdmin: user.isAdmin, tags: user.tags }, req, {
      strict: true,
    });
    if (tier !== 'free') return;

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
      logger.info('[freeTierDailyCapGate] daily cap reached', {
        userId: user.id,
        spentToday: todaySpend,
        dailyCap: cap,
      });
      throw new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
        errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
        retryAfter,
      });
    }
  } catch (err) {
    if (err instanceof TooManyRequestsError) throw err;
    // Fail open: a transient DB or settings read failure must not block the user.
    logger.warn('[freeTierDailyCapGate] cap check failed; allowing request', { error: err });
  }
}

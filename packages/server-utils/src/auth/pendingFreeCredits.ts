import { signupProtection } from './signupProtection';
import { createSignupGrantRiskCollector } from './signupGrantRisk';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  grantPackageRepository,
  userRepository,
} from '@bike4mind/database';
import type { INetworkMeta } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';

export type PendingFreeCreditUser = { id: string; tags?: readonly string[] | null; pendingCreditGrant?: number | null };

export type PendingFreeCreditReleaseResult = {
  creditsGranted: number;
  /** Balance after the grant; null when nothing was granted. */
  currentCredits: number | null;
  /** The persisted tags with PENDING_FREE_CREDITS_TAG removed; null when the tag was not removed. */
  tags: string[] | null;
};

const NOTHING_RELEASED: PendingFreeCreditReleaseResult = { creditsGranted: 0, currentCredits: null, tags: null };

/**
 * The disposable-email gate registerUser applies before any free credits. A settings read failure
 * withholds the grant.
 */
export async function isEligibleForFreeCredits(email: string, logger: Logger): Promise<boolean> {
  try {
    return !(await userService.shouldBlockDisposableEmail(email, {
      adminSettings: adminSettingsRepository,
      signupProtection,
    }));
  } catch (error) {
    logger.error('Free-credit eligibility check failed; withholding the grant', error);
    return false;
  }
}

/**
 * Release a PENDING_FREE_CREDITS_TAG grant and persist the tag removal. No-op for an untagged user.
 * On failure the tag stays for the backfillPendingFreeCredits script. `signupNetwork` is the
 * request's network when the account is being created now; otherwise its recorded signupMeta is used.
 */
export async function releaseVerifiedPendingFreeCredits(
  user: PendingFreeCreditUser,
  reason: string,
  logger: Logger,
  signupNetwork?: INetworkMeta,
  options: { bypassBudget?: boolean } = {}
): Promise<PendingFreeCreditReleaseResult> {
  let release: Awaited<ReturnType<typeof userService.releasePendingFreeCredits>>;
  try {
    release = await userService.releasePendingFreeCredits(
      { id: user.id, tags: user.tags ? [...user.tags] : null, pendingCreditGrant: user.pendingCreditGrant ?? null },
      {
        db: {
          adminSettings: adminSettingsRepository,
          creditTransactions: creditTransactionRepository,
          creditLots: creditLotRepository,
          users: userRepository,
          signupProtection,
          grantPackages: grantPackageRepository,
        },
        reason,
        logger,
        collectRiskSignals: createSignupGrantRiskCollector(signupNetwork),
        bypassBudget: options.bypassBudget,
        emitRiskBand: async band => {
          logger.info(`signup-grant-assessed-${band}`);
        },
      }
    );
  } catch (error) {
    // Documented never to throw; guarded anyway because a throw here would fail a proven login.
    logger.error(`Pending free-credit release failed for user ${user.id}`, error);
    return NOTHING_RELEASED;
  }
  if (!release.released) return NOTHING_RELEASED;

  const granted = { creditsGranted: release.creditsGranted, currentCredits: release.currentCredits };
  try {
    const updated = await userRepository.clearPendingFreeCreditGrant(user.id);
    if (!updated) throw new Error('User no longer available after pending credit release');
    logger.info(`Released ${release.creditsGranted} pending free credits to user ${user.id} (${reason})`);
    return { ...granted, tags: updated.tags ?? [] };
  } catch (error) {
    // The credits landed under an idempotent transactionId, so the backfill script can safely
    // re-run the release to clear the tag.
    logger.error(`Released pending free credits for user ${user.id} but the tag removal failed`, error);
    return { ...granted, tags: null };
  }
}

import { CreditHolderType, IUserDocument } from '@bike4mind/common';
import {
  creditTransactionRepository,
  organizationRepository,
  pendingCreditHoldRepository,
  userRepository,
  type PendingCreditHold,
  withTransaction,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { CreditLedgerEntry } from '@bike4mind/services/creditService';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@server/utils/errors';
import { assertApiKeyOrgMembership } from '@server/billing/assertApiKeyOrgMembership';

export type { CreditLedgerEntry };

/**
 * How long a reservation may stay unsettled before apps/workers/src/cron/creditHoldSweep.ts refunds it.
 * Far past the longest request these routes serve, so a live request is never swept.
 */
export const CREDIT_HOLD_TTL_MS = 60 * 60_000;

const SETTLE_CLAIM_ATTEMPTS = 3;

export type CreditReservation = {
  ownerId: string;
  ownerType: CreditHolderType;
  /** Credits held against the owner; 0 when nothing was reserved (credits off, or a free request). */
  reservedCredits: number;
  /**
   * Return the whole reservation - the provider call failed and incurred no cost. Never throws: the route
   * is already answering with the provider failure, so a failed refund is logged (with the owner, for a
   * manual credit) rather than replacing that answer with a 500.
   */
  refund(): Promise<void>;
  /**
   * Keep `chargedCredits` (at most the reservation), refund the rest, and write the ledger row.
   * Returns the credits actually charged. A ledger-write failure is logged, not thrown: the balance
   * already moved at reservation, so the customer was charged and only the audit row is missing.
   */
  settle(chargedCredits: number, entry: CreditLedgerEntry): Promise<number>;
};

/** The slice of an authenticated request billing reads. */
type BillingRequest = {
  user?: IUserDocument;
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;
  logger: Logger;
};

type ReserveRequestCreditsParams = {
  req: BillingRequest;
  requiredCredits: number;
  /** The enforceCredits admin setting; unset reads as off, as it always has on these routes. */
  enforceCredits: boolean | undefined;
  /** Noun phrase for the insufficient-credits copy, e.g. "music generation". */
  featureLabel: string;
};

/**
 * Reserve a request's cost BEFORE any provider cost is incurred, for the stateless paid API routes
 * (pages/api/ai/music.ts, sound-effects.ts, pages/api/v1/embeddings.ts). The money movement itself
 * lives in creditService/creditHold.ts; this resolves the billing owner and the request-only checks.
 *
 * Billing owner, in precedence order:
 *   1. Org-billed API key -> its organization (billingOwnerType invariant).
 *   2. User-billed API key -> the user (explicit intent; ignore the org seat).
 *   3. Browser/JWT caller -> the user's own organization seat if any, matching
 *      image/video generation; otherwise the user.
 * The user always stays the actor for attribution + per-member usage tracking.
 *
 * Gated on enforceCredits, so self-host / credits-off deployments run free; the owner is still
 * resolved so usage events attribute correctly. Throws a 422 `insufficient_credits` when the
 * member cap or the pool cannot cover the reservation.
 */
export async function reserveRequestCredits({
  req,
  requiredCredits,
  enforceCredits,
  featureLabel,
}: ReserveRequestCreditsParams): Promise<CreditReservation> {
  if (!req.user) throw new BadRequestError('User not found');
  const userId = req.user.id;
  const billingOrganizationId = req.apiKeyInfo
    ? req.apiKeyInfo.billingOwnerType === CreditHolderType.Organization
      ? req.apiKeyInfo.organizationId
      : undefined
    : (req.user.organizationId?.toString() ?? undefined);
  const ownerId = billingOrganizationId ?? userId;
  const ownerType = billingOrganizationId ? CreditHolderType.Organization : CreditHolderType.User;

  if (!enforceCredits || requiredCredits <= 0) {
    return { ownerId, ownerType, reservedCredits: 0, refund: async () => {}, settle: async () => 0 };
  }

  const holdAdapters = {
    users: userRepository,
    organizations: organizationRepository,
    creditTransactions: creditTransactionRepository,
    deductCredits: creditService.deductCreditsWithOrgSupport,
  };
  // One transaction, so the balance never moves without a pending row the sweep can find, and a row
  // never exists for a balance that did not move.
  const { hold, pending } = await withTransaction(async () => {
    const hold = await creditService.holdCredits(
      {
        userId,
        organizationId: billingOrganizationId ?? null,
        requiredCredits,
        featureLabel,
        logger: req.logger,
        // Re-checked against the roster holdCredits just fetched - no extra query.
        assertBillable: (billingUser, billingOrg) =>
          assertApiKeyOrgMembership({ billingOrg, billingUser, isApiKeyCaller: Boolean(req.apiKeyInfo) }),
      },
      holdAdapters
    );
    const expiresAt = new Date(Date.now() + CREDIT_HOLD_TTL_MS);
    return { hold, pending: await pendingCreditHoldRepository.record(hold, featureLabel, expiresAt) };
  });

  const logHoldError = (message: string, err?: unknown) =>
    req.logger.error(`${featureLabel} ${message}`, {
      holdId: pending.id,
      ownerId: hold.ownerId,
      ownerType: hold.ownerType,
      reservedCredits: hold.reservedCredits,
      ...(err === undefined ? {} : { error: err instanceof Error ? err.message : 'Unknown error' }),
    });

  return {
    ownerId: hold.ownerId,
    ownerType: hold.ownerType,
    reservedCredits: hold.reservedCredits,
    refund: async () => {
      try {
        // Claim and release commit together: a failed release keeps the row, and the sweep refunds it later.
        const refunded = await withTransaction(async () => {
          if (!(await pendingCreditHoldRepository.claim(pending.id))) return false;
          await creditService.releaseCreditHold(hold, holdAdapters);
          return true;
        });
        if (!refunded) {
          req.logger.warn(`${featureLabel} refund found its credit hold already swept`, { holdId: pending.id });
        }
      } catch (err) {
        logHoldError('refund failed - left for the expired-hold sweep', err);
      }
    },
    settle: async (chargedCredits, entry) => {
      // Not one transaction with the settlement: its ledger write runs outside any caller session. Only
      // the claimant may settle, so a settle that cannot claim leaves the row for the sweep to refund.
      let claimed: PendingCreditHold | null = null;
      for (let attempt = 1; ; attempt++) {
        try {
          claimed = await pendingCreditHoldRepository.claim(pending.id);
          break;
        } catch (err) {
          if (attempt >= SETTLE_CLAIM_ATTEMPTS) {
            logHoldError('settle could not claim its credit hold - request not charged, left for the sweep', err);
            return 0;
          }
        }
      }
      if (!claimed) {
        logHoldError('settle found its credit hold already swept - request not charged');
        return 0;
      }
      return creditService.settleCreditHold(
        hold,
        chargedCredits,
        entry,
        { featureLabel, logger: req.logger },
        holdAdapters
      );
    },
  };
}

import { CreditHolderType, IUserDocument } from '@bike4mind/common';
import {
  creditTransactionRepository,
  organizationRepository,
  pendingCreditHoldRepository,
  userRepository,
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
 * Requests still running after this deadline may be refunded by the sweep.
 */
export const CREDIT_HOLD_TTL_MS = 60 * 60_000;

const SETTLEMENT_ATTEMPTS = 3;

export type CreditReservation = {
  ownerId: string;
  ownerType: CreditHolderType;
  /** Credits held against the owner; 0 when nothing was reserved (credits off, or a free request). */
  reservedCredits: number;
  /**
   * Return the whole reservation - the provider call failed and incurred no cost. Never throws: the route
   * is already answering with the provider failure, so a failed refund is logged and left for the sweep
   * rather than replacing that answer with a 500.
   */
  refund(): Promise<void>;
  /**
   * Keep `chargedCredits` (at most the reservation), refund the rest, and write the ledger row.
   * Returns the credits actually charged when confirmed. All writes commit together; an aborted
   * settlement leaves the reservation available for the sweep. Unconfirmed outcomes are logged.
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
      const charged = Number.isFinite(chargedCredits)
        ? Math.min(Math.max(chargedCredits, 0), hold.reservedCredits)
        : hold.reservedCredits;
      for (let attempt = 1; ; attempt++) {
        try {
          // The receipt, partial refund, member usage and ledger commit together. A process death or
          // failed write leaves either the original refundable hold or the completed settlement.
          return await withTransaction(async () => {
            if (!(await pendingCreditHoldRepository.markSettled(pending.id, charged))) {
              const settled = await pendingCreditHoldRepository.findSettlement(pending.id);
              if (settled !== null) return settled;
              logHoldError('settle found its credit hold already swept - request not charged');
              return 0;
            }
            return creditService.settleCreditHold(
              hold,
              chargedCredits,
              entry,
              { featureLabel, logger: req.logger, throwOnWriteFailure: true },
              holdAdapters
            );
          });
        } catch (err) {
          // A commit can succeed while its acknowledgement is lost. Never infer a refund from a
          // missing claim: the durable receipt tells us whether this settlement already committed.
          try {
            const settled = await pendingCreditHoldRepository.findSettlement(pending.id);
            if (settled !== null) return settled;
          } catch (reconcileError) {
            logHoldError('settle could not read its settlement receipt', reconcileError);
          }
          if (attempt >= SETTLEMENT_ATTEMPTS) {
            logHoldError('settle could not confirm outcome - any pending hold remains refundable', err);
            return 0;
          }
        }
      }
    },
  };
}

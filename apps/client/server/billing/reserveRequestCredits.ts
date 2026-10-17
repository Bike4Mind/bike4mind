import { CreditHolderType, IUserDocument, type CreditHoldRecord } from '@bike4mind/common';
import { creditTransactionRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { CreditLedgerEntry } from '@bike4mind/services/creditService';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@server/utils/errors';
import { assertApiKeyOrgMembership } from '@server/billing/assertApiKeyOrgMembership';

export type { CreditLedgerEntry };

export type CreditReservation = {
  ownerId: string;
  ownerType: CreditHolderType;
  /** Credits held against the owner; 0 when nothing was reserved (credits off, or a free request). */
  reservedCredits: number;
  /** The serializable hold, for settling in a later request (see settleHeldCredits); null when nothing was reserved. */
  hold: CreditHoldRecord | null;
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

const holdAdapters = {
  users: userRepository,
  organizations: organizationRepository,
  creditTransactions: creditTransactionRepository,
  deductCredits: creditService.deductCreditsWithOrgSupport,
};

type ReserveRequestCreditsParams = {
  req: BillingRequest;
  requiredCredits: number;
  /** The enforceCredits admin setting; unset reads as off, as it always has on these routes. */
  enforceCredits: boolean | undefined;
  /** Noun phrase for the insufficient-credits copy, e.g. "music generation". */
  featureLabel: string;
  /** Overrides rule 3's org seat with the org the caller is acting in (a chat turn's active org); null = the user. */
  organizationId?: string | null;
};

/**
 * The organization a request bills, or undefined when it bills the user. Precedence: org-billed API key
 * -> its org; user-billed API key -> the user; JWT caller -> `organizationId` when given (null = the
 * user), else the user's own org seat.
 */
export function resolveRequestBillingOrgId(
  req: Pick<BillingRequest, 'user' | 'apiKeyInfo'>,
  organizationId?: string | null
): string | undefined {
  if (req.apiKeyInfo) {
    return req.apiKeyInfo.billingOwnerType === CreditHolderType.Organization
      ? req.apiKeyInfo.organizationId
      : undefined;
  }
  if (organizationId !== undefined) return organizationId ?? undefined;
  return req.user?.organizationId?.toString() ?? undefined;
}

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
  organizationId,
}: ReserveRequestCreditsParams): Promise<CreditReservation> {
  if (!req.user) throw new BadRequestError('User not found');
  const userId = req.user.id;
  const billingOrganizationId = resolveRequestBillingOrgId(req, organizationId);
  const ownerId = billingOrganizationId ?? userId;
  const ownerType = billingOrganizationId ? CreditHolderType.Organization : CreditHolderType.User;

  if (!enforceCredits || requiredCredits <= 0) {
    return { ownerId, ownerType, reservedCredits: 0, hold: null, refund: async () => {}, settle: async () => 0 };
  }

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

  return {
    ownerId: hold.ownerId,
    ownerType: hold.ownerType,
    reservedCredits: hold.reservedCredits,
    hold,
    refund: async () => {
      try {
        await creditService.releaseCreditHold(hold, holdAdapters);
      } catch (err) {
        req.logger.error(`${featureLabel} refund failed - caller charged for a failed request`, {
          ownerId: hold.ownerId,
          ownerType: hold.ownerType,
          reservedCredits: hold.reservedCredits,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    },
    settle: (chargedCredits, entry) =>
      creditService.settleCreditHold(hold, chargedCredits, entry, { featureLabel, logger: req.logger }, holdAdapters),
  };
}

/**
 * Settle a hold persisted by an earlier request (e.g. an async batch settled on poll). Same clamp
 * and ledger semantics as CreditReservation.settle; a charge of 0 refunds the whole hold.
 */
export function settleHeldCredits(
  hold: CreditHoldRecord,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  context: { featureLabel: string; logger: Logger }
): Promise<number> {
  return creditService.settleCreditHold(hold, chargedCredits, entry, context, holdAdapters);
}

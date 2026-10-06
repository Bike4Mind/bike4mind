import { CreditHolderType, IUserDocument } from '@bike4mind/common';
import { creditTransactionRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService, organizationService } from '@bike4mind/services';
import type { CreditLedgerEntry } from '@bike4mind/services/creditService';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@server/utils/errors';

export type { CreditLedgerEntry };

export type CreditReservation = {
  ownerId: string;
  ownerType: CreditHolderType;
  /** Credits held against the owner; 0 when nothing was reserved (credits off, or a free request). */
  reservedCredits: number;
  /** Return the whole reservation - the provider call failed and incurred no cost. */
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
  const hold = await creditService.holdCredits(
    {
      userId,
      organizationId: billingOrganizationId ?? null,
      requiredCredits,
      featureLabel,
      assertBillable: (billingUser, billingOrg) => {
        // Mint-time trust is not use-time trust: an org-billed API key carries its billing target
        // stamped on it and never revisited, so a key whose minting user has since left the org would
        // keep drawing on that org's shared pool. Re-check against the roster just fetched - no extra
        // query - and fail closed, matching executeCompletion. Scoped to the API-key path only: that
        // caller asked for org billing explicitly, whereas the implicit JWT own-org fallback must
        // degrade rather than 403 a caller on a stale pointer (see resolveBillingOrgId).
        //
        // A platform admin mints org-billed keys on a customer org's behalf (user-api-keys/index.ts
        // admits them explicitly) and is never on that org's roster, so the authority arm is checked
        // here rather than inside isCurrentOrgMember, which reports roster attachment only.
        if (
          billingOrg &&
          req.apiKeyInfo &&
          !billingUser.isAdmin &&
          !organizationService.isCurrentOrgMember(billingOrg, userId)
        ) {
          throw new BadRequestError(
            'This API key bills an organization you are no longer a member of. Re-mint the key to continue.'
          );
        }
      },
    },
    holdAdapters
  );

  return {
    ownerId: hold.ownerId,
    ownerType: hold.ownerType,
    reservedCredits: hold.reservedCredits,
    refund: () => creditService.releaseCreditHold(hold, holdAdapters),
    settle: (chargedCredits, entry) =>
      creditService.settleCreditHold(hold, chargedCredits, entry, { featureLabel, logger: req.logger }, holdAdapters),
  };
}

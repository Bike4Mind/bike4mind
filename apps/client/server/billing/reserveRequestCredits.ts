import {
  CreditHolderType,
  ICreditHolder,
  ICreditHolderMethods,
  insufficientCreditsError,
  IOrganizationDocument,
  IUserDocument,
} from '@bike4mind/common';
import { creditTransactionRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService, organizationService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@server/utils/errors';

type DeductCreditsParams = Parameters<typeof creditService.deductCreditsWithOrgSupport>[0];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The ledger row a settlement writes, minus what the reservation already knows. */
export type CreditLedgerEntry = DistributiveOmit<DeductCreditsParams, 'user' | 'organization' | 'credits'>;

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
 * (pages/api/ai/music.ts, sound-effects.ts, pages/api/v1/embeddings.ts).
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
  const holderMethods: ICreditHolderMethods = billingOrganizationId ? organizationRepository : userRepository;

  if (!enforceCredits || requiredCredits <= 0) {
    return { ownerId, ownerType, reservedCredits: 0, refund: async () => {}, settle: async () => 0 };
  }

  const billingUser = await userRepository.findById(userId);
  if (!billingUser) throw new BadRequestError('User not found');
  let billingOrg: IOrganizationDocument | null = null;
  if (billingOrganizationId) {
    billingOrg = await organizationRepository.findById(billingOrganizationId);
    if (!billingOrg) throw new BadRequestError('Billing organization not found');
  }

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

  // Org-billed: enforce the per-member cap before touching the shared pool. This is an
  // independent pre-flight - the settlement write (deductCreditsWithOrgSupport) does NOT
  // re-check the cap, so this path is the only enforcement point for these routes.
  if (billingOrg && creditService.isMemberCreditCapExceeded(billingOrg, userId, requiredCredits)) {
    throw insufficientCreditsError(
      `Your organization member credit limit has been reached for ${featureLabel}. Contact your organization administrator.`
    );
  }

  // The atomic decrement doubles as the balance check (closing the check-then-charge race) and
  // guarantees the charge can never fail after the provider output is produced. Rolled back
  // immediately if it overdraws.
  const reservedHolder = await holderMethods.incrementCredits(ownerId, -requiredCredits);
  if (!reservedHolder || reservedHolder.currentCredits < 0) {
    if (reservedHolder) await holderMethods.incrementCredits(ownerId, requiredCredits);
    const availableCredits = (reservedHolder?.currentCredits ?? 0) + requiredCredits;
    throw insufficientCreditsError(
      billingOrg
        ? `Your organization does not have enough credits for ${featureLabel}. It currently has ${availableCredits} credits and this requires approximately ${requiredCredits}.`
        : `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
    );
  }

  return {
    ownerId,
    ownerType,
    reservedCredits: requiredCredits,
    refund: async () => {
      await holderMethods.incrementCredits(ownerId, requiredCredits);
    },
    settle: async (chargedCredits, entry) =>
      settleReservation({
        chargedCredits: Math.min(Math.max(chargedCredits, 0), requiredCredits),
        reservedCredits: requiredCredits,
        entry,
        billingUser,
        billingOrg,
        reservedHolder,
        holderMethods,
        ownerId,
        featureLabel,
        logger: req.logger,
      }),
  };
}

type SettleReservationParams = {
  chargedCredits: number;
  reservedCredits: number;
  entry: CreditLedgerEntry;
  billingUser: IUserDocument;
  billingOrg: IOrganizationDocument | null;
  reservedHolder: ICreditHolder;
  holderMethods: ICreditHolderMethods;
  ownerId: string;
  featureLabel: string;
  logger: Logger;
};

async function settleReservation({
  chargedCredits,
  reservedCredits,
  entry,
  billingUser,
  billingOrg,
  reservedHolder,
  holderMethods,
  ownerId,
  featureLabel,
  logger,
}: SettleReservationParams): Promise<number> {
  const overReserved = reservedCredits - chargedCredits;
  // The ledger row records the post-settlement balance, so it must see the refund.
  const settledHolder =
    overReserved > 0
      ? ((await holderMethods.incrementCredits(ownerId, overReserved)) ?? reservedHolder)
      : reservedHolder;
  if (chargedCredits === 0) return 0;

  try {
    // The balance already moved at reservation, so this only writes the ledger row + per-member
    // usage tracking (skipBalanceUpdate).
    await creditService.deductCreditsWithOrgSupport(
      { ...entry, user: billingUser, organization: billingOrg, credits: chargedCredits } as DeductCreditsParams,
      {
        db: {
          creditTransactions: creditTransactionRepository,
          users: userRepository,
          organizations: organizationRepository,
        },
      },
      { skipBalanceUpdate: true, currentCreditHolder: settledHolder }
    );
  } catch (err) {
    logger.error(`${featureLabel} usage transaction write failed - credits charged, ledger row missing`, {
      userId: billingUser.id,
      organizationId: billingOrg?.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
  return chargedCredits;
}

import {
  BadRequestError,
  CreditHolderType,
  insufficientCreditsError,
  type ICreditHolder,
  type ICreditHolderMethods,
  type IOrganizationDocument,
  type IUserDocument,
  type IUserRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  deductCreditsWithOrgSupport,
  type DeductCreditsAdapters,
  type DeductCreditsParams,
} from './deductCreditsWithOrgSupport';
import { isMemberCreditCapExceeded } from './memberCreditCap';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The ledger row a settlement writes, minus what the hold already knows. */
export type CreditLedgerEntry = DistributiveOmit<DeductCreditsParams, 'user' | 'organization' | 'credits'>;

/**
 * Credits moved out of an owner's balance ahead of a paid provider call. Plain JSON-serializable
 * data, so a job document can carry it and a different process can settle or release it.
 */
export type CreditHold = {
  ownerId: string;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  /** The actor: attribution and per-member usage tracking, even when the org pays. */
  userId: string;
  organizationId: string | null;
  reservedCredits: number;
  /** The owner's balance right after the hold; the ledger row's balance when no refund lands. */
  balanceAfterHold: number;
};

export type CreditHoldAdapters = {
  users: ICreditHolderMethods & Pick<IUserRepository, 'findById'>;
  organizations: DeductCreditsAdapters['db']['organizations'];
  creditTransactions: DeductCreditsAdapters['db']['creditTransactions'];
  /**
   * The ledger writer; defaults to deductCreditsWithOrgSupport. Injectable so a caller that
   * resolves it through the @bike4mind/services namespace (reserveRequestCredits, and its
   * module-mocked tests) keeps that seam.
   */
  deductCredits?: typeof deductCreditsWithOrgSupport;
};

type HolderAdapters = Pick<CreditHoldAdapters, 'users' | 'organizations'>;

const holderMethodsFor = (hold: Pick<CreditHold, 'ownerType'>, adapters: HolderAdapters): ICreditHolderMethods =>
  hold.ownerType === CreditHolderType.Organization ? adapters.organizations : adapters.users;

/**
 * Hold `requiredCredits` against the user, or against `organizationId`'s pool when given, BEFORE
 * any provider cost is incurred. Throws a 422 `insufficient_credits` when the member cap or the
 * pool cannot cover it; nothing has moved when it throws.
 */
export async function holdCredits(
  params: {
    userId: string;
    organizationId: string | null;
    requiredCredits: number;
    featureLabel: string;
    /** Runs after the user/org are loaded and before any balance moves; throw to refuse. */
    assertBillable?: (user: IUserDocument, organization: IOrganizationDocument | null) => void;
  },
  adapters: CreditHoldAdapters
): Promise<CreditHold> {
  const { userId, organizationId, requiredCredits, featureLabel } = params;

  const user = await adapters.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');
  let organization: IOrganizationDocument | null = null;
  if (organizationId) {
    organization = await adapters.organizations.findById(organizationId);
    if (!organization) throw new BadRequestError('Billing organization not found');
  }

  params.assertBillable?.(user, organization);

  // Org-billed: enforce the per-member cap before touching the shared pool. This is an
  // independent pre-flight - the settlement write (deductCreditsWithOrgSupport) does NOT
  // re-check the cap, so this is the only enforcement point for held requests.
  if (organization && isMemberCreditCapExceeded(organization, userId, requiredCredits)) {
    throw insufficientCreditsError(
      `Your organization member credit limit has been reached for ${featureLabel}. Contact your organization administrator.`
    );
  }

  const ownerId = organizationId ?? userId;
  const ownerType = organization ? CreditHolderType.Organization : CreditHolderType.User;
  const holderMethods = holderMethodsFor({ ownerType }, adapters);

  // The atomic decrement doubles as the balance check (closing the check-then-charge race) and
  // guarantees the charge can never fail after the provider output is produced. Rolled back
  // immediately if it overdraws.
  const reservedHolder = await holderMethods.incrementCredits(ownerId, -requiredCredits);
  if (!reservedHolder || reservedHolder.currentCredits < 0) {
    if (reservedHolder) await holderMethods.incrementCredits(ownerId, requiredCredits);
    const availableCredits = (reservedHolder?.currentCredits ?? 0) + requiredCredits;
    throw insufficientCreditsError(
      organization
        ? `Your organization does not have enough credits for ${featureLabel}. It currently has ${availableCredits} credits and this requires approximately ${requiredCredits}.`
        : `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
    );
  }

  return {
    ownerId,
    ownerType,
    userId,
    organizationId: organization ? organizationId : null,
    reservedCredits: requiredCredits,
    balanceAfterHold: reservedHolder.currentCredits,
  };
}

/** Return the whole hold - the provider call failed and incurred no cost. */
export async function releaseCreditHold(hold: CreditHold, adapters: HolderAdapters): Promise<void> {
  if (hold.reservedCredits <= 0) return;
  await holderMethodsFor(hold, adapters).incrementCredits(hold.ownerId, hold.reservedCredits);
}

/**
 * Keep `chargedCredits` (clamped to [0, reservedCredits]), refund the rest, and write the ledger
 * row. Returns the credits actually charged. Never throws: the balance already moved at hold time,
 * so a failed refund or ledger write is logged and only the audit trail is affected.
 */
export async function settleCreditHold(
  hold: CreditHold,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  context: { featureLabel: string; logger: Logger },
  adapters: CreditHoldAdapters
): Promise<number> {
  const { featureLabel, logger } = context;
  const charged = Math.min(Math.max(chargedCredits, 0), hold.reservedCredits);
  const overReserved = hold.reservedCredits - charged;
  // The ledger row records the post-settlement balance, so it must see the refund.
  let settledHolder: ICreditHolder = { currentCredits: hold.balanceAfterHold };
  if (overReserved > 0) {
    // Settlement runs after the provider already delivered, so a failed partial refund is logged
    // rather than thrown: throwing would 500 a paid-for result and strand the whole reservation.
    try {
      settledHolder =
        (await holderMethodsFor(hold, adapters).incrementCredits(hold.ownerId, overReserved)) ?? settledHolder;
    } catch (err) {
      logger.error(`${featureLabel} over-reserved credit refund failed - caller over-charged`, {
        ownerId: hold.ownerId,
        overReserved,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
  if (charged === 0) return 0;

  try {
    // Loaded here, not carried on the hold, so a different process can settle it.
    const user = await adapters.users.findById(hold.userId);
    if (!user) throw new Error('User not found');
    const organization = hold.organizationId ? await adapters.organizations.findById(hold.organizationId) : null;
    if (hold.organizationId && !organization) throw new Error('Billing organization not found');

    const deductCredits = adapters.deductCredits ?? deductCreditsWithOrgSupport;
    // The balance already moved at hold time, so this only writes the ledger row + per-member
    // usage tracking (skipBalanceUpdate).
    await deductCredits(
      { ...entry, user, organization, credits: charged } as DeductCreditsParams,
      {
        db: {
          creditTransactions: adapters.creditTransactions,
          users: adapters.users,
          organizations: adapters.organizations,
        },
      },
      { skipBalanceUpdate: true, currentCreditHolder: settledHolder }
    );
  } catch (err) {
    logger.error(`${featureLabel} usage transaction write failed - credits charged, ledger row missing`, {
      userId: hold.userId,
      organizationId: hold.organizationId ?? undefined,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
  return charged;
}

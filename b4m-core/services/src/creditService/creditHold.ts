import {
  BadRequestError,
  CreditHolderType,
  insufficientCreditsError,
  type CreditHoldRecord,
  type ICreditHolder,
  type ICreditHolderMethods,
  type IOrganizationDocument,
  type IUserDocument,
  type IUserRepository,
} from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';
import {
  deductCreditsWithOrgSupport,
  type DeductCreditsAdapters,
  type DeductCreditsParams,
} from './deductCreditsWithOrgSupport';
import { isMemberCreditCapExceeded } from './memberCreditCap';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The ledger row a settlement writes, minus what the hold already knows. */
export type CreditLedgerEntry = DistributiveOmit<DeductCreditsParams, 'user' | 'organization' | 'credits'>;

/** Defined in common so a job document can carry it; see CreditHoldRecord. */
export type CreditHold = CreditHoldRecord;

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
 * pool cannot cover it. Nothing has moved when it throws, unless the overdraw rollback itself fails,
 * which is logged at error level for a manual credit.
 */
export async function holdCredits(
  params: {
    userId: string;
    organizationId: string | null;
    requiredCredits: number;
    featureLabel: string;
    logger: ILogger;
    /** Runs after the user/org are loaded and before any balance moves; throw to refuse. */
    assertBillable?: (user: IUserDocument, organization: IOrganizationDocument | null) => void;
  },
  adapters: CreditHoldAdapters
): Promise<CreditHold> {
  const { userId, organizationId, requiredCredits, featureLabel, logger } = params;
  // A negative hold would credit the owner and NaN would corrupt the balance ($inc NaN passes the
  // `< 0` check), so refuse before any read. A pricing bug, not caller input: not a 400.
  if (!Number.isFinite(requiredCredits) || requiredCredits <= 0) {
    throw new Error(`${featureLabel} credit hold requires a positive finite amount, got ${requiredCredits}`);
  }

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
  // Loaded above, so a null here means the holder was deleted mid-request: nothing moved, and it is not a
  // balance problem, so it must not read as one.
  if (!reservedHolder) {
    throw new BadRequestError(organization ? 'Billing organization not found' : 'User not found');
  }
  if (reservedHolder.currentCredits < 0) {
    try {
      await holderMethods.incrementCredits(ownerId, requiredCredits);
    } catch (err) {
      // Still a 422 to the caller (that is the truth about their balance), but the owner is now short by
      // the whole hold with no ledger row, so it needs a manual credit.
      logger.error(`${featureLabel} overdraw rollback failed - owner debited with no charge`, {
        ownerId,
        ownerType,
        requiredCredits,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
    const availableCredits = reservedHolder.currentCredits + requiredCredits;
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

/**
 * Return the whole hold - the provider call failed and incurred no cost. Throws when the write rejects
 * (a deleted holder resolves silently), so a caller that can retry (a job's terminal settlement) does
 * not record it as released; a caller that cannot logs it instead (reserveRequestCredits).
 */
export async function releaseCreditHold(hold: CreditHold, adapters: HolderAdapters): Promise<void> {
  if (hold.reservedCredits <= 0) return;
  await holderMethodsFor(hold, adapters).incrementCredits(hold.ownerId, hold.reservedCredits);
}

/**
 * Keep `chargedCredits` (clamped to [0, reservedCredits]), refund the rest, and write the ledger
 * row. Returns the credits actually charged. By default failures are logged after the balance moved.
 * Transactional callers set throwOnWriteFailure so every failed write aborts their settlement instead.
 */
export async function settleCreditHold(
  hold: CreditHold,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  context: { featureLabel: string; logger: ILogger; throwOnWriteFailure?: boolean },
  adapters: CreditHoldAdapters
): Promise<number> {
  const { featureLabel, logger } = context;
  // A non-finite charge is a pricing bug after the provider delivered: keep the whole hold rather
  // than throw (or let NaN through the clamp), and make it loud.
  if (!Number.isFinite(chargedCredits)) {
    logger.error(`${featureLabel} settled with a non-finite charge - keeping the full reservation`, {
      ownerId: hold.ownerId,
      chargedCredits: String(chargedCredits),
    });
  }
  const charged = Number.isFinite(chargedCredits)
    ? Math.min(Math.max(chargedCredits, 0), hold.reservedCredits)
    : hold.reservedCredits;
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
      if (context.throwOnWriteFailure) throw err;
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
    if (context.throwOnWriteFailure) throw err;
    logger.error(`${featureLabel} usage transaction write failed - credits charged, ledger row missing`, {
      userId: hold.userId,
      organizationId: hold.organizationId ?? undefined,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
  return charged;
}

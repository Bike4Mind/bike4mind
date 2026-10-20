import {
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { CreditHolderType, UnprocessableEntityError, type IUserDocument } from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';
import { reserveRequestCredits, type CreditLedgerEntry } from '@server/billing/reserveRequestCredits';

// A billing state, not a bug. Each caller maps it onto its own established
// response (422 `insufficient_credits` or 400) so this change does not
// move any route's contract.
export class InsufficientCreditsPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsPreflightError';
  }
}

export interface CreditPreflightArgs {
  userId: string;
  // What the call is expected to cost. Omit when it cannot be known before the
  // provider runs; the gate then only requires a positive balance.
  estimatedCredits?: number;
  // Noun phrase for the refusal copy, e.g. "text-to-speech".
  featureLabel: string;
  // Org pool to check instead of the user's personal balance. The post-call deduction charges the
  // same owner, so the gate and the charge cannot disagree about who pays.
  billingOrganizationId?: string | null;
}

/**
 * Pre-flight gate for the user-billed routes that charge AFTER the provider call
 * (TTS in deductTtsCredits.ts, transcription in pages/api/ai/transcribe). Run it
 * before the provider so a caller who cannot pay never incurs provider cost.
 *
 * A check, not a reservation (compare server/billing/reserveRequestCredits.ts):
 * the post-call deduction moves the balance, so concurrent requests can still
 * overdraw by the cost of the calls in flight.
 *
 * Gated on the enforceCredits admin setting, so a deployment with credits
 * switched off never rejects a zero-balance user. The post-call deduction is not
 * gated on the setting: it always charges, so with enforcement off balances can
 * go negative without bound (as realtime voice does).
 */
export async function assertPreflightCredits({
  userId,
  estimatedCredits,
  featureLabel,
  billingOrganizationId,
}: CreditPreflightArgs): Promise<void> {
  const [settings, user, organization] = await Promise.all([
    getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] }),
    userRepository.findById(userId),
    billingOrganizationId ? organizationRepository.findById(billingOrganizationId) : null,
  ]);
  // Unconditional: with no holder there is nothing for the post-call deduction to charge.
  if (!user) throw new InsufficientCreditsPreflightError('User not found');
  if (billingOrganizationId && !organization) {
    throw new InsufficientCreditsPreflightError('Billing organization not found');
  }
  if (!getSettingsValue('enforceCredits', settings)) return;

  const requiredCredits = Math.max(estimatedCredits ?? 0, 0);

  // Org pool: the member cap is checked here because the post-call deduction does not re-check it
  // (deductCreditsWithOrgSupport reserves the cap for pre-reserved routes - see creditHold.ts).
  if (organization) {
    if (creditService.isMemberCreditCapExceeded(organization, userId, requiredCredits)) {
      throw new InsufficientCreditsPreflightError(
        `Your organization member credit limit has been reached for ${featureLabel}. Contact your organization administrator.`
      );
    }
    const orgCredits = organization.currentCredits ?? 0;
    if (orgCredits > 0 && orgCredits >= requiredCredits) return;
    throw new InsufficientCreditsPreflightError(
      `Your organization does not have enough credits for ${featureLabel}. It currently has ${orgCredits} credits and this requires approximately ${requiredCredits}.`
    );
  }

  const availableCredits = user.currentCredits ?? 0;
  if (availableCredits > 0 && availableCredits >= requiredCredits) return;

  throw new InsufficientCreditsPreflightError(
    requiredCredits > 0
      ? `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
      : `Insufficient credits for ${featureLabel}`
  );
}

/** The slice of an authenticated request a hold reads. */
export interface PreflightBillingRequest {
  user: IUserDocument;
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;
  logger: ILogger;
}

export interface PreflightCreditHold {
  /** Who the reservation bills: the org pool, or the user. */
  ownerId: string;
  ownerType: CreditHolderType;
  /**
   * Keep the actual cost (at most the hold), refund the rest, and write the ledger row. A hold that
   * reserved nothing - credits enforcement off, or a zero estimate - charges the same amount directly,
   * as these routes always have. Returns the credits charged; never throws, because the provider already
   * delivered and a failed write is logged for ops rather than failing the paid-for result.
   */
  settle(credits: number, entry: CreditLedgerEntry): Promise<number>;
  /** Return the whole hold: the provider call failed and incurred no cost. Never throws. */
  release(): Promise<void>;
}

/**
 * Reserve the estimated cost of a provider call (TTS, transcription) BEFORE it runs, so concurrent
 * calls cannot overdraw the balance, on top of the same durable hold primitive the stateless paid
 * API routes use (server/billing/reserveRequestCredits.ts): the hold is a `PendingCreditHold` row,
 * so a lambda killed mid-call leaves a refund for the expired-hold sweep instead of a silent debit.
 *
 * Refuses with InsufficientCreditsPreflightError like assertPreflightCredits.
 */
export async function holdPreflightCredits({
  req,
  requiredCredits,
  featureLabel,
  billingOrganizationId,
}: {
  req: PreflightBillingRequest;
  requiredCredits: number;
  featureLabel: string;
  billingOrganizationId?: string | null;
}): Promise<PreflightCreditHold> {
  const { user, logger } = req;
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });

  let reservation: Awaited<ReturnType<typeof reserveRequestCredits>>;
  try {
    reservation = await reserveRequestCredits({
      req,
      requiredCredits: Math.max(requiredCredits, 0),
      enforceCredits: getSettingsValue('enforceCredits', settings),
      featureLabel,
      billingOrganizationId,
    });
  } catch (err) {
    if (err instanceof UnprocessableEntityError) throw new InsufficientCreditsPreflightError(err.message);
    throw err;
  }

  return {
    ownerId: reservation.ownerId,
    ownerType: reservation.ownerType,
    async settle(credits, entry) {
      if (reservation.reservedCredits > 0) return reservation.settle(credits, entry);
      return chargeDirectly({ userId: user.id, reservation, credits, entry, featureLabel, logger });
    },
    async release() {
      await reservation.refund();
    },
  };
}

type DirectChargeArgs = {
  userId: string;
  reservation: Pick<PreflightCreditHold, 'ownerId' | 'ownerType'>;
  credits: number;
  entry: CreditLedgerEntry;
  featureLabel: string;
  logger: ILogger;
};

/**
 * Charge a call that reserved nothing, through the same ledger writer a settled hold uses so the
 * org rollup is identical either way. Swallows a write failure: the caller is already answering with
 * a paid-for result.
 */
async function chargeDirectly({
  userId,
  reservation,
  credits,
  entry,
  featureLabel,
  logger,
}: DirectChargeArgs): Promise<number> {
  if (!Number.isFinite(credits)) {
    logger.error(`${featureLabel} settled with a non-finite charge`, { userId, credits: String(credits) });
    return 0;
  }
  const charged = Math.max(credits, 0);
  if (charged === 0) return 0;

  try {
    const [user, organization] = await Promise.all([
      userRepository.findById(userId),
      reservation.ownerType === CreditHolderType.Organization
        ? organizationRepository.findById(reservation.ownerId)
        : null,
    ]);
    if (!user) throw new Error('User not found');
    if (reservation.ownerType === CreditHolderType.Organization && !organization) {
      throw new Error('Billing organization not found');
    }

    await creditService.deductCreditsWithOrgSupport(
      { ...entry, user, organization, credits: charged },
      {
        db: {
          users: userRepository,
          organizations: organizationRepository,
          creditTransactions: creditTransactionRepository,
        },
      }
    );
    return charged;
  } catch (err) {
    logger.error(`${featureLabel} credit settlement failed - billing may be missed`, { userId, charged, err });
    return 0;
  }
}

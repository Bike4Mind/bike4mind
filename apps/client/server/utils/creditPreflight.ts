import { adminSettingsRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

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

import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

// A billing state, not a bug. Each caller maps it onto its own established
// response (422 `insufficient_credits`, 402, or 400) so this change does not
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
}: CreditPreflightArgs): Promise<void> {
  const [settings, user] = await Promise.all([
    getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] }),
    userRepository.findById(userId),
  ]);
  // Unconditional: with no holder there is nothing for the post-call deduction to charge.
  if (!user) throw new InsufficientCreditsPreflightError('User not found');
  if (!getSettingsValue('enforceCredits', settings)) return;

  const availableCredits = user.currentCredits ?? 0;
  const requiredCredits = Math.max(estimatedCredits ?? 0, 0);
  if (availableCredits > 0 && availableCredits >= requiredCredits) return;

  throw new InsufficientCreditsPreflightError(
    requiredCredits > 0
      ? `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
      : `Insufficient credits for ${featureLabel}`
  );
}

import { CreditHolderType, UnprocessableEntityError } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
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
}

/**
 * Pre-flight gate for a call whose cost is only known after a step that costs
 * nothing (the transcribe upload URL). A check, not a reservation: a route that
 * runs a paid provider holds with holdPreflightCredits instead.
 *
 * Gated on the enforceCredits admin setting, so a deployment with credits
 * switched off never rejects a zero-balance user. Returns whether enforcement is on.
 */
export async function assertPreflightCredits({
  userId,
  estimatedCredits,
  featureLabel,
}: CreditPreflightArgs): Promise<boolean> {
  const [settings, user] = await Promise.all([
    getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] }),
    userRepository.findById(userId),
  ]);
  // Unconditional: with no holder there is nothing for the post-call deduction to charge.
  if (!user) throw new InsufficientCreditsPreflightError('User not found');
  if (!getSettingsValue('enforceCredits', settings)) return false;

  const availableCredits = user.currentCredits ?? 0;
  const requiredCredits = Math.max(estimatedCredits ?? 0, 0);
  if (availableCredits > 0 && availableCredits >= requiredCredits) return true;

  throw new InsufficientCreditsPreflightError(
    requiredCredits > 0
      ? `You do not have enough credits for ${featureLabel}. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
      : `Insufficient credits for ${featureLabel}`
  );
}

type PreflightUsageType = 'text_to_speech_usage' | 'speech_to_text_usage';

export interface PreflightCreditHold {
  /**
   * Charge `credits` and write the ledger row; with a hold, the charge is capped at the hold and the
   * rest refunded. Returns the credits charged. Never throws: the provider already delivered, so a
   * failed write is logged for ops rather than failing the paid-for result.
   */
  settle(credits: number, entry: { type: PreflightUsageType; model: string; sessionId: string }): Promise<number>;
  /** Return the whole hold: the provider call failed and incurred no cost. Never throws. */
  release(): Promise<void>;
}

const holdAdapters = {
  users: userRepository,
  organizations: organizationRepository,
  creditTransactions: creditTransactionRepository,
};

/**
 * Hold the estimated cost of a user-billed provider call (TTS, transcription) BEFORE the provider
 * runs, so concurrent calls cannot overdraw the balance; settle on the measured cost afterwards.
 * Refuses with InsufficientCreditsPreflightError like assertPreflightCredits. With enforcement
 * off nothing is held and settle charges unconditionally, as these routes always have.
 */
export async function holdPreflightCredits(
  args: CreditPreflightArgs & { logger: ILogger }
): Promise<PreflightCreditHold> {
  const { userId, featureLabel, logger } = args;
  const enforced = await assertPreflightCredits(args);
  const requiredCredits = args.estimatedCredits ?? 0;

  let hold: creditService.CreditHold | undefined;
  if (enforced && requiredCredits > 0) {
    try {
      hold = await creditService.holdCredits(
        { userId, organizationId: null, requiredCredits, featureLabel, logger },
        holdAdapters
      );
    } catch (err) {
      if (err instanceof UnprocessableEntityError) throw new InsufficientCreditsPreflightError(err.message);
      throw err;
    }
  }

  return {
    async settle(credits, entry) {
      const charged = hold ? Math.min(Math.max(credits, 0), hold.reservedCredits) : Math.max(credits, 0);
      try {
        let currentCreditHolder: { currentCredits: number } | undefined;
        if (hold) {
          const overReserved = hold.reservedCredits - charged;
          currentCreditHolder = (overReserved > 0
            ? await userRepository.incrementCredits(userId, overReserved)
            : null) ?? {
            currentCredits: hold.balanceAfterHold,
          };
        }
        if (charged > 0) {
          await creditService.subtractCredits(
            { ...entry, ownerId: userId, ownerType: CreditHolderType.User, credits: charged },
            {
              db: { creditTransactions: creditTransactionRepository },
              creditHolderMethods: userRepository,
              // The hold already moved the balance; only the ledger row is written.
              skipBalanceUpdate: Boolean(hold),
              currentCreditHolder,
            }
          );
        }
      } catch (err) {
        logger.error(`${featureLabel} credit settlement failed - billing may be missed`, { userId, charged, err });
      }
      return charged;
    },
    async release() {
      if (!hold) return;
      try {
        await creditService.releaseCreditHold(hold, holdAdapters);
      } catch (err) {
        logger.error(`${featureLabel} refund failed - caller charged for a failed request`, {
          userId,
          reservedCredits: hold.reservedCredits,
          err,
        });
      }
    },
  };
}

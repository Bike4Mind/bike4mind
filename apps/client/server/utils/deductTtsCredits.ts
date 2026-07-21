import { CreditHolderType, VoiceGenerationVendor, computeTtsUsd } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { usdToCredits } from '@bike4mind/utils';
import { userRepository, creditTransactionRepository, usageEventRepository } from '@bike4mind/database';
import { type ILogger } from '@bike4mind/observability';

// Thrown by assertTtsCreditsAvailable when the caller can't pay. Callers map
// this to a 402 - it's a billing state, not a bug. Metering is what stops an
// authenticated user from draining the operator's admin provider key for free.
export class InsufficientTtsCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientTtsCreditsError';
  }
}

// Pre-flight balance gate. Run BEFORE calling the provider so a broke caller
// never incurs provider cost. Mirrors the transcribe route's pre-check.
export async function assertTtsCreditsAvailable(userId: string): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) throw new InsufficientTtsCreditsError('User not found');
  if ((user.currentCredits ?? 0) <= 0) {
    throw new InsufficientTtsCreditsError('Insufficient credits for text-to-speech');
  }
}

export interface DeductTtsArgs {
  userId: string;
  vendor: VoiceGenerationVendor;
  // Resolved provider model (VoiceSynthesisResult.model) - the per-model billing key.
  model: string;
  // Input character count (VoiceSynthesisResult.characters) - the billable unit.
  characters: number;
  logger: ILogger;
}

/**
 * Charge a user for one successful TTS synthesis. Cost is per input character,
 * provider+model aware (voicePricing). Non-fatal: synthesis already succeeded,
 * so a billing failure is logged for ops rather than surfaced to the caller.
 * Mirrors deductTranscriptionCredits in the transcribe route.
 */
export async function deductTtsCredits({ userId, vendor, model, characters, logger }: DeductTtsArgs): Promise<void> {
  const costUsd = computeTtsUsd(vendor, model, characters);
  const credits = usdToCredits(costUsd);
  if (credits <= 0) return;

  const sessionId = `tts-${userId}-${Date.now()}`;

  try {
    await creditService.subtractCredits(
      {
        type: 'text_to_speech_usage',
        ownerId: userId,
        ownerType: CreditHolderType.User,
        credits,
        model,
        sessionId,
      },
      {
        db: { creditTransactions: creditTransactionRepository },
        creditHolderMethods: userRepository,
      }
    );

    // Dual-write usage event: analytics only, never billing.
    usageEventRepository
      .record({
        requestId: sessionId,
        userId,
        ownerId: userId,
        ownerType: CreditHolderType.User,
        sessionId,
        feature: 'text_to_speech',
        provider: vendor,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        units: characters,
        costUsd,
        creditsCharged: credits,
        status: 'ok',
      })
      .catch(err => logger.warn('Failed to record TTS usage event', { err }));
  } catch (err) {
    // Non-fatal: synthesis succeeded; log the billing miss for ops visibility.
    logger.error('TTS credit deduction failed - billing may be missed', { userId, credits, err });
  }
}

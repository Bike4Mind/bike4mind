import { VoiceGenerationVendor, computeTtsUsd } from '@bike4mind/common';
import { usdToCreditsStochastic } from '@bike4mind/utils';
import { usageEventRepository } from '@bike4mind/database';
import { type ILogger } from '@bike4mind/observability';
import type { PreflightCreditHold } from '@server/utils/creditPreflight';

export interface DeductTtsArgs {
  // Held before synthesis (holdPreflightCredits); settled here on the measured characters.
  hold: PreflightCreditHold;
  userId: string;
  vendor: VoiceGenerationVendor;
  // Resolved provider model (VoiceSynthesisResult.model) - the per-model billing key.
  model: string;
  // Input character count (VoiceSynthesisResult.characters) - the billable unit.
  characters: number;
  logger: ILogger;
}

/**
 * Settle one successful TTS synthesis against its hold. Cost is per input
 * character, provider+model aware (voicePricing). The hold covers every candidate
 * vendor; settlement charges the actual cost and refunds the rest.
 * Non-fatal: synthesis already succeeded, so a billing failure is
 * logged for ops (inside hold.settle) rather than surfaced to the caller.
 */
export async function deductTtsCredits({
  hold,
  userId,
  vendor,
  model,
  characters,
  logger,
}: DeductTtsArgs): Promise<void> {
  const costUsd = computeTtsUsd(vendor, model, characters);
  const sessionId = `tts-${userId}-${Date.now()}`;
  const credits = await hold.settle(usdToCreditsStochastic(costUsd), {
    type: 'text_to_speech_usage',
    model,
    sessionId,
  });

  // Dual-write usage event: analytics only, never billing.
  usageEventRepository
    .record({
      requestId: sessionId,
      userId,
      ownerId: hold.ownerId,
      ownerType: hold.ownerType,
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
}

import { CreditHolderType, VoiceGenerationVendor, computeTtsUsd } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { usdToCredits } from '@bike4mind/utils';
import {
  userRepository,
  organizationRepository,
  creditTransactionRepository,
  usageEventRepository,
} from '@bike4mind/database';
import { type ILogger } from '@bike4mind/observability';

export interface DeductTtsArgs {
  userId: string;
  vendor: VoiceGenerationVendor;
  // Resolved provider model (VoiceSynthesisResult.model) - the per-model billing key.
  model: string;
  // Input character count (VoiceSynthesisResult.characters) - the billable unit.
  characters: number;
  // Org whose pool pays; the user stays the actor. Omitted or null bills the user.
  billingOrganizationId?: string | null;
  logger: ILogger;
}

/**
 * Charge for one successful TTS synthesis. Cost is per input character,
 * provider+model aware (voicePricing). Non-fatal: synthesis already succeeded,
 * so a billing failure is logged for ops rather than surfaced to the caller.
 * Mirrors deductTranscriptionCredits in the transcribe route.
 *
 * An org-billed synthesis debits the org pool through deductCreditsWithOrgSupport,
 * which also tracks the member's usage so the org's per-member cap sees speech spend.
 */
export async function deductTtsCredits({
  userId,
  vendor,
  model,
  characters,
  billingOrganizationId,
  logger,
}: DeductTtsArgs): Promise<void> {
  const costUsd = computeTtsUsd(vendor, model, characters);
  const credits = usdToCredits(costUsd);
  if (credits <= 0) return;

  const sessionId = `tts-${userId}-${Date.now()}`;

  try {
    const [user, organization] = await Promise.all([
      userRepository.findById(userId),
      billingOrganizationId ? organizationRepository.findById(billingOrganizationId) : null,
    ]);
    if (!user) throw new Error('User not found');
    if (billingOrganizationId && !organization) throw new Error('Billing organization not found');

    await creditService.deductCreditsWithOrgSupport(
      {
        type: 'text_to_speech_usage',
        user,
        organization,
        credits,
        model,
        sessionId,
      },
      {
        db: {
          users: userRepository,
          organizations: organizationRepository,
          creditTransactions: creditTransactionRepository,
        },
      }
    );

    const ownerId = organization?.id ?? userId;
    const ownerType = organization ? CreditHolderType.Organization : CreditHolderType.User;

    // Dual-write usage event: analytics only, never billing.
    usageEventRepository
      .record({
        requestId: sessionId,
        userId,
        ownerId,
        ownerType,
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

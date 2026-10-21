import { ModelInfo, IOrganizationDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { insufficientCreditsError } from '@bike4mind/common';
import { CostInput } from '../../imageCostCalculator/types';
import { estimateImageCredits, UnsupportedImageModelError } from '../../../imageCost';
import { AudioCostInput, estimateAudioCredits } from '../../../audioCost';

export async function validateUserCredits(
  user: any,
  modelInfo: ModelInfo,
  n: number,
  input: CostInput,
  logger: Logger,
  organization?: IOrganizationDocument | null
): Promise<{ requiredCredits: number; usdCost: number }> {
  let userCredits = user.currentCredits ?? 0;

  if (organization) {
    logger.updateMetadata({ creditsSource: 'organization', creditsSourceId: organization.id });
    userCredits = organization.currentCredits;
  } else {
    logger.updateMetadata({ creditsSource: 'user', creditsSourceId: user.id });
  }

  let requiredCredits: number;
  let usdCost: number;
  try {
    ({ requiredCredits, usdCost } = estimateImageCredits(modelInfo, n, input));
  } catch (err) {
    // Only an unsupported model is remapped to the generic error (+ log). The
    // finite-check UnprocessableEntityError and any unexpected calculator failure
    // propagate unchanged rather than being masked as "Model not supported".
    if (err instanceof UnsupportedImageModelError) {
      logger.error(`No cost calculator found for model: ${modelInfo.id}`);
      throw new Error('Model not supported');
    }
    throw err;
  }

  if (userCredits < requiredCredits) {
    const creditsType = organization ? 'organization' : 'personal';
    throw insufficientCreditsError(
      `You do not have enough ${creditsType} credits to complete this request. You currently have ${userCredits} credits, and this request requires approximately ${requiredCredits} credits. Try reducing the number of images to lower the credit cost.`
    );
  }

  // usdCost is the n-scaled total so it describes the same quantity as requiredCredits.
  return { requiredCredits, usdCost };
}

/**
 * Audio-generation (TTS + sound-effects) parallel to validateUserCredits: an up-front
 * affordability gate. Speech bills per character (conservative gate estimate; settlement
 * uses the resolved model + actual characters in ToolBuilder.settleAudioCredits), sound
 * effects per duration second. Throws insufficient_credits before the paid provider call.
 */
export function validateAudioCredits(
  user: { currentCredits?: number; id: string },
  input: AudioCostInput,
  logger: Logger,
  organization?: IOrganizationDocument | null
): { requiredCredits: number; usdCost: number; units: number } {
  const availableCredits = organization ? organization.currentCredits : (user.currentCredits ?? 0);
  logger.updateMetadata(
    organization
      ? { creditsSource: 'organization', creditsSourceId: organization.id }
      : { creditsSource: 'user', creditsSourceId: user.id }
  );

  const { requiredCredits, usdCost, units } = estimateAudioCredits(input);

  if (availableCredits < requiredCredits) {
    const creditsType = organization ? 'organization' : 'personal';
    throw insufficientCreditsError(
      `You do not have enough ${creditsType} credits to generate audio. You currently have ${availableCredits} credits, and this request requires approximately ${requiredCredits} credits.`
    );
  }

  return { requiredCredits, usdCost, units };
}

import { ModelInfo, IOrganizationDocument, MusicGenerationVendor } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { insufficientCreditsError } from '@bike4mind/common';
import { CostInput } from '../../imageCostCalculator/types';
import { estimateImageCredits, UnsupportedImageModelError } from '../../../imageCost';
import { estimateMusicCredits } from '../../../musicCost';

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
 * Music-generation parallel to validateUserCredits: the cost is deterministic from
 * `lengthMs` (the provider generates exactly the billed length), so the estimate here
 * drives the up-front balance check AND the toolCreditsMap reservation the host settles
 * at quest end. `billedSeconds`/`usdCost` are carried through for usage-event analytics.
 */
export function validateMusicCredits(
  user: { currentCredits?: number; id: string },
  provider: MusicGenerationVendor,
  lengthMs: number,
  logger: Logger,
  organization?: IOrganizationDocument | null
): { requiredCredits: number; usdCost: number; billedSeconds: number } {
  const availableCredits = organization ? organization.currentCredits : (user.currentCredits ?? 0);
  logger.updateMetadata(
    organization
      ? { creditsSource: 'organization', creditsSourceId: organization.id }
      : { creditsSource: 'user', creditsSourceId: user.id }
  );

  const { requiredCredits, usdCost, billedSeconds } = estimateMusicCredits(provider, { lengthMs });

  if (availableCredits < requiredCredits) {
    const creditsType = organization ? 'organization' : 'personal';
    throw insufficientCreditsError(
      `You do not have enough ${creditsType} credits to generate music. You currently have ${availableCredits} credits, and this request requires approximately ${requiredCredits} credits. Try a shorter track to lower the credit cost.`
    );
  }

  return { requiredCredits, usdCost, billedSeconds };
}

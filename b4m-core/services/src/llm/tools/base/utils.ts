import { ModelInfo, IOrganizationDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { insufficientCreditsError } from '@bike4mind/common';
import { CostInput } from '../../imageCostCalculator/types';
import { estimateImageCredits, UnsupportedImageModelError } from '../../../imageCost';

export async function validateUserCredits(
  user: { currentCredits?: number; id: string },
  modelInfo: ModelInfo,
  n: number,
  input: CostInput,
  logger: Logger,
  organization?: IOrganizationDocument | null,
  // Credits this turn already committed to earlier tool calls; the balance snapshot predates them.
  committedCredits = 0
): Promise<{ requiredCredits: number; usdCost: number }> {
  return validateImageCredits(user, modelInfo, n, input, logger, organization, committedCredits);
}

/** Synchronous so a tool can check and commit its estimate without yielding to another call. */
export function validateImageCredits(
  user: { currentCredits?: number; id: string },
  modelInfo: ModelInfo,
  n: number,
  input: CostInput,
  logger: Logger,
  organization?: IOrganizationDocument | null,
  // Credits this turn already committed to earlier tool calls; the balance snapshot predates them.
  committedCredits = 0
): { requiredCredits: number; usdCost: number } {
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

  userCredits -= committedCredits;
  if (userCredits < requiredCredits) {
    const creditsType = organization ? 'organization' : 'personal';
    throw insufficientCreditsError(
      `You do not have enough ${creditsType} credits to complete this request. You currently have ${userCredits} credits, and this request requires approximately ${requiredCredits} credits. Try reducing the number of images to lower the credit cost.`
    );
  }

  // usdCost is the n-scaled total so it describes the same quantity as requiredCredits.
  return { requiredCredits, usdCost };
}

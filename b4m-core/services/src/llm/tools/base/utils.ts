import { ImageModels, ModelInfo, IOrganizationDocument, isGPTImageModel, isGeminiImageModel } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { usdToCredits, UnprocessableEntityError } from '@bike4mind/utils';
import { OpenAICostInput, OpenAIImageCostCalculator } from '../../imageCostCalculator/OpenAIImageCostCalculator';
import { FluxImageCostCalculator } from '../../imageCostCalculator/FluxImageCostCalculator';
import { GeminiImageCostCalculator } from '../../imageCostCalculator/GeminiImageCostCalculator';
import { CostInput } from '../../imageCostCalculator/types';

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

  let usdCost = 0;

  if (isGPTImageModel(modelInfo.id)) {
    const openAiCostCalculator = new OpenAIImageCostCalculator();
    // isGPTImageModel narrows the model id but TypeScript can't propagate that to the CostInput union;
    // the conditional guarantees this branch only sees an OpenAICostInput.
    usdCost = openAiCostCalculator.getCost(input as OpenAICostInput);
  } else if (
    modelInfo.id === ImageModels.FLUX_PRO_ULTRA ||
    modelInfo.id === ImageModels.FLUX_PRO_1_1 ||
    modelInfo.id === ImageModels.FLUX_PRO ||
    modelInfo.id === ImageModels.FLUX_KONTEXT_PRO ||
    modelInfo.id === ImageModels.FLUX_KONTEXT_MAX
  ) {
    const fluxCostCalculator = new FluxImageCostCalculator();
    usdCost = fluxCostCalculator.getCost({
      model: modelInfo.id,
    });
  } else if (modelInfo.id === ImageModels.GROK_IMAGINE_IMAGE_QUALITY) {
    usdCost = 0.055;
  } else if (isGeminiImageModel(modelInfo.id)) {
    // Gemini image generation cost
    const geminiCostCalculator = new GeminiImageCostCalculator();
    usdCost = geminiCostCalculator.getCost({
      model: modelInfo.id,
    });
  } else {
    logger.error(`No cost calculator found for model: ${modelInfo.id}`);
    throw new Error('Model not supported');
  }

  const totalUsdCost = usdCost * n;
  const requiredCredits = usdToCredits(totalUsdCost);

  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(`Unable to compute credit cost for model "${modelInfo.id}" (got ${usdCost}).`);
  }

  if (userCredits < requiredCredits) {
    const creditsType = organization ? 'organization' : 'personal';
    throw new UnprocessableEntityError(
      `You do not have enough ${creditsType} credits to complete this request. You currently have ${userCredits} credits, and this request requires approximately ${requiredCredits} credits. Try reducing the number of images to lower the credit cost.`
    );
  }

  // usdCost is the n-scaled total so it describes the same quantity as requiredCredits.
  return { requiredCredits, usdCost: totalUsdCost };
}

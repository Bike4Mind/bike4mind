import {
  ImageModels,
  ModelInfo,
  isGPTImageModel,
  isGeminiImageModel,
  UnprocessableEntityError,
} from '@bike4mind/common';
import { usdToCredits } from '@bike4mind/utils';
import { OpenAICostInput, OpenAIImageCostCalculator } from '../llm/imageCostCalculator/OpenAIImageCostCalculator';
import { FluxImageCostCalculator } from '../llm/imageCostCalculator/FluxImageCostCalculator';
import { GeminiImageCostCalculator } from '../llm/imageCostCalculator/GeminiImageCostCalculator';
import { CostInput } from '../llm/imageCostCalculator/types';

/**
 * Shared image cost estimation. Kept in its own module (not the charging path in
 * llm/tools/base/utils) so the client-side cost preview can import it without
 * dragging that module's server deps (Logger/observability, credit-error
 * helpers). Only pure price-table lookups live here.
 */

/** Thrown when no cost calculator exists for a model - lets callers distinguish
 *  "unsupported model" from an unexpected calculator failure. */
export class UnsupportedImageModelError extends Error {
  constructor(modelId: string) {
    super(`Model not supported: ${modelId}`);
    this.name = 'UnsupportedImageModelError';
  }
}

/**
 * Per-image USD cost for an image model. Pure and DOM/logger-free so it can run
 * client-side (cost preview) AND server-side (charging) from one code path -
 * never reimplement the price tables. Throws UnsupportedImageModelError for an
 * unknown model.
 */
export function computeImageUsdCostPerImage(modelId: string, input: CostInput): number {
  if (isGPTImageModel(modelId)) {
    // isGPTImageModel narrows the model id but TypeScript can't propagate that to the CostInput union;
    // the conditional guarantees this branch only sees an OpenAICostInput.
    return new OpenAIImageCostCalculator().getCost(input as OpenAICostInput);
  }
  if (
    modelId === ImageModels.FLUX_PRO_ULTRA ||
    modelId === ImageModels.FLUX_PRO_1_1 ||
    modelId === ImageModels.FLUX_PRO ||
    modelId === ImageModels.FLUX_KONTEXT_PRO ||
    modelId === ImageModels.FLUX_KONTEXT_MAX
  ) {
    return new FluxImageCostCalculator().getCost({ model: modelId });
  }
  if (modelId === ImageModels.GROK_IMAGINE_IMAGE_QUALITY) {
    return 0.055;
  }
  if (isGeminiImageModel(modelId)) {
    return new GeminiImageCostCalculator().getCost({ model: modelId });
  }
  throw new UnsupportedImageModelError(modelId);
}

/**
 * Credit cost of generating `n` images with `modelInfo`, using the SAME cost
 * path as charging (`validateUserCredits`) so a client-side preview always
 * matches what the user is billed. Returns the n-scaled USD alongside credits.
 */
export function estimateImageCredits(
  modelInfo: ModelInfo,
  n: number,
  input: CostInput
): { requiredCredits: number; usdCost: number } {
  const totalUsdCost = computeImageUsdCostPerImage(modelInfo.id, input) * n;
  const requiredCredits = usdToCredits(totalUsdCost);
  if (!Number.isFinite(requiredCredits)) {
    throw new UnprocessableEntityError(`Unable to compute credit cost for model "${modelInfo.id}".`);
  }
  return { requiredCredits, usdCost: totalUsdCost };
}

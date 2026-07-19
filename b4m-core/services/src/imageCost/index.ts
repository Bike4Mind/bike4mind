import {
  ImageModels,
  ModelInfo,
  isGPTImageModel,
  isGeminiImageModel,
  UnprocessableEntityError,
  // From common, NOT @bike4mind/utils: the utils barrel pulls fab-pipeline
  // (aws-sdk/dns/v8) and would break the browser build for the cost preview.
  usdToCredits,
} from '@bike4mind/common';
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
  // Self-hosted local image models run on the operator's own hardware: no
  // provider spend, so they are free. Guarding here keeps them out of the
  // UnsupportedImageModelError path, which credit validation surfaces as
  // "Model not supported" in ToolBuilder.onStart.
  if (modelId.startsWith('local-image/')) {
    return 0;
  }
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
  const usdPerImage = computeImageUsdCostPerImage(modelInfo.id, input);
  const totalUsdCost = usdPerImage * n;
  const requiredCredits = usdToCredits(totalUsdCost);
  if (!Number.isFinite(requiredCredits)) {
    // Keep the per-image value in the message - it distinguishes "calculator
    // returned NaN/Infinity" from a failure before the multiply in a bug report.
    throw new UnprocessableEntityError(
      `Unable to compute credit cost for model "${modelInfo.id}" (got ${usdPerImage}).`
    );
  }
  return { requiredCredits, usdCost: totalUsdCost };
}

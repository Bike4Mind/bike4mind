import {
  GenerateImageToolCall,
  ImageModels,
  ModelInfo,
  isBflImageModel,
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
import { toImageCostInput } from '../llm/tools/imageToolBilling';
import { resolveImageArgs } from '../llm/tools/implementation/imageGeneration/resolveImageArgs';

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
  // Every BFL model is priced in FluxImageCostCalculator, and this is the only place the
  // dispatch could miss one: an id missing here throws "Model not supported" at the credit
  // gate, so the family predicate (which cannot drift from BFL_IMAGE_MODELS) decides.
  if (isBflImageModel(modelId)) {
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
 * path as charging (`estimateCredits`). `requiredCredits` is the rounded-up
 * gate/preview figure; the final debit settles `usdCost` with usdToCreditsStochastic.
 * Returns the n-scaled USD alongside credits.
 * A GPT model's input images (`inputImageCount`) are added once, not per output image.
 */
export function estimateImageCredits(
  modelInfo: ModelInfo,
  n: number,
  input: CostInput
): { requiredCredits: number; usdCost: number } {
  const usdPerImage = computeImageUsdCostPerImage(modelInfo.id, input);
  const inputUsd = isGPTImageModel(modelInfo.id)
    ? new OpenAIImageCostCalculator().getInputImageCost(input as OpenAICostInput)
    : 0;
  const totalUsdCost = usdPerImage * n + inputUsd;
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

/**
 * Credits for ONE image from the image_generation tool at the client's saved selection
 * (`imageConfig`), for the pre-send price shown in the Smart Tools picker. Resolves args
 * through `resolveImageArgs` and prices through `toImageCostInput`, the same pair
 * `ToolBuilder.settleImageCredits` charges with, so the gpt-image-1 -> gpt-image-2 upgrade
 * and the omitted-quality pin match settlement. The assistant can still override
 * n/quality/size per call, so this is the price at the saved settings, not a quote.
 * Returns null when the resolved model is not in `models` or cannot be priced. A free model
 * (local-image) returns 0: settlement charges nothing, though `requiredCredits` floors at 1.
 */
export function estimateImageToolCredits(
  models: ModelInfo[],
  imageConfig: GenerateImageToolCall | undefined
): { model: string; credits: number } | null {
  const { model, size, quality } = resolveImageArgs(imageConfig, {});
  const modelInfo = models.find(m => m.id === model);
  if (!modelInfo) return null;
  try {
    const input = toImageCostInput('image_generation', { model, size, quality });
    const { requiredCredits, usdCost } = estimateImageCredits(modelInfo, 1, input);
    return { model, credits: usdCost === 0 ? 0 : requiredCredits };
  } catch {
    return null;
  }
}

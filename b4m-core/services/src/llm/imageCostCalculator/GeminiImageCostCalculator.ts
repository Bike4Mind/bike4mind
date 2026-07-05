import { ImageModels, type GeminiImageModel } from '@bike4mind/common';
import { CostCalculator } from './types';

// Re-exported for backward compatibility; the canonical type is derived from
// GEMINI_IMAGE_MODELS so this calculator stays in sync with the routing allowlist.
export type { GeminiImageModel };

export interface GeminiImageCostInput {
  model: GeminiImageModel;
}

/**
 * Per-image USD cost. Each generated image is ~1290 output tokens, so
 * cost ~= (1290 / 1_000_000) * output-$/1M-tokens. Output prices mirror
 * GeminiBackend.getModelInfo() pricing.
 *
 * Input tokens (prompt text + any image-edit inputs) are intentionally NOT
 * charged here, matching the flat per-image estimate used by the OpenAI and
 * Flux calculators: per-image cost is dominated by the fixed ~1290 output
 * tokens, priced 60-120x higher per token than input, so input is a small
 * fraction of the total (GEMINI_3_PRO_IMAGE would need ~77.5K input tokens to
 * match one image's output cost). Charging input would be a cross-cutting
 * change across every image calculator and the credit-validation flow (which
 * runs before prompt tokens are counted), so it is tracked separately rather
 * than diverging Gemini's pricing here.
 */
const GEMINI_IMAGE_USD_PER_IMAGE: Record<GeminiImageModel, number> = {
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: 0.039, // $30/1M output
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: 0.039, // $30/1M output
  [ImageModels.GEMINI_3_PRO_IMAGE]: 0.155, // $120/1M output (Nano Banana Pro)
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: 0.078, // $60/1M output (Nano Banana 2); 1290 tok rounded up like the others
};

export class GeminiImageCostCalculator implements CostCalculator<GeminiImageCostInput> {
  getCost(input: GeminiImageCostInput): number {
    const cost = GEMINI_IMAGE_USD_PER_IMAGE[input.model];

    if (cost === undefined) {
      throw new Error(`Unsupported Gemini image model: ${input.model}`);
    }

    return cost;
  }
}

import { ImageModels } from '@bike4mind/common';
import { CostCalculator } from './types';

export type OpenAIModel =
  ImageModels.GPT_IMAGE_1 | ImageModels.GPT_IMAGE_1_5 | ImageModels.GPT_IMAGE_1_MINI | ImageModels.GPT_IMAGE_2 | string;

export interface BaseOpenAIInput {
  model: OpenAIModel;
}

// Mirrors what the Zod OpenAIImageGenerationInput schema actually permits at runtime:
// quality may be undefined or 'auto' (in addition to the listed tiers); size may be undefined,
// null, or an arbitrary 'WxH' string (gpt-image-2 supports flexible sizing).
export interface OpenAIGPTImageInput extends BaseOpenAIInput {
  model: OpenAIModel;
  quality?: 'standard' | 'hd' | 'low' | 'medium' | 'high' | 'auto';
  size?: '1024x1024' | '1024x1536' | '1536x1024' | (string & {}) | null;
}

export type OpenAICostInput = OpenAIGPTImageInput;

type Tier = 'low' | 'medium' | 'high';
type KnownSize = '1024x1024' | '1024x1536' | '1536x1024';
type PriceKey = `${Tier}_${KnownSize}`;

const DEFAULT_TIER: Tier = 'medium';
// OpenAI picks the render effort for `quality: 'auto'` per request and never tells us which
// tier it used, so we bill the ceiling it could have rendered. The prose counterpart of this
// constant lives in OpenAIImageService.toGptImageQuality (utils), which cannot import it. Under-billing is unrecoverable
// (the credit hold is set once, before the call, and never reconciled); over-billing an
// 'auto' request the user opted into is the survivable side of that trade.
const AUTO_TIER: Tier = 'high';
const DEFAULT_SIZE: KnownSize = '1024x1024';

/**
 * The only sizes with a real price row; anything else is estimated at DEFAULT_SIZE.
 * The image_generation tool schema advertises exactly this set to the model so the
 * ledger is never asked to price a size it does not know - must stay in sync with
 * `resolveImageArgs` / the tool's `size` enum, which import it from here.
 */
export const PRICEABLE_IMAGE_SIZES: readonly KnownSize[] = ['1024x1024', '1024x1536', '1536x1024'] as const;

export function isPriceableImageSize(size: unknown): size is KnownSize {
  return typeof size === 'string' && PRICEABLE_IMAGE_SIZES.includes(size as KnownSize);
}

const GPT_IMAGE_1_PRICES: Record<PriceKey, number> = {
  low_1024x1024: 0.011,
  low_1024x1536: 0.016,
  low_1536x1024: 0.016,
  medium_1024x1024: 0.042,
  medium_1024x1536: 0.063,
  medium_1536x1024: 0.063,
  high_1024x1024: 0.167,
  high_1024x1536: 0.25,
  high_1536x1024: 0.25,
};

const GPT_IMAGE_1_5_PRICES: Record<PriceKey, number> = {
  low_1024x1024: 0.009,
  low_1024x1536: 0.013,
  low_1536x1024: 0.013,
  medium_1024x1024: 0.034,
  medium_1024x1536: 0.05,
  medium_1536x1024: 0.05,
  high_1024x1024: 0.133,
  high_1024x1536: 0.2,
  high_1536x1024: 0.2,
};

const GPT_IMAGE_2_PRICES: Record<PriceKey, number> = {
  low_1024x1024: 0.006,
  low_1024x1536: 0.005,
  low_1536x1024: 0.005,
  medium_1024x1024: 0.053,
  medium_1024x1536: 0.041,
  medium_1536x1024: 0.041,
  high_1024x1024: 0.211,
  high_1024x1536: 0.165,
  high_1536x1024: 0.165,
};

const GPT_IMAGE_1_MINI_PRICES: Record<PriceKey, number> = {
  low_1024x1024: 0.005,
  low_1024x1536: 0.006,
  low_1536x1024: 0.006,
  medium_1024x1024: 0.011,
  medium_1024x1536: 0.015,
  medium_1536x1024: 0.015,
  high_1024x1024: 0.036,
  high_1024x1536: 0.052,
  high_1536x1024: 0.052,
};

const PRICE_TABLES: Partial<Record<ImageModels, Record<PriceKey, number>>> = {
  [ImageModels.GPT_IMAGE_1]: GPT_IMAGE_1_PRICES,
  [ImageModels.GPT_IMAGE_1_5]: GPT_IMAGE_1_5_PRICES,
  [ImageModels.GPT_IMAGE_1_MINI]: GPT_IMAGE_1_MINI_PRICES,
  [ImageModels.GPT_IMAGE_2]: GPT_IMAGE_2_PRICES,
};

/**
 * Normalize versioned model IDs to their base model for pricing lookup.
 * 'gpt-image-2-2026-04-21' -> GPT_IMAGE_2, 'gpt-image-1.5-preview' -> GPT_IMAGE_1_5, etc.
 */
function normalizeModelId(modelId: string): ImageModels | null {
  if (Object.values(ImageModels).includes(modelId as ImageModels)) {
    return modelId as ImageModels;
  }
  if (modelId.startsWith('gpt-image-2')) return ImageModels.GPT_IMAGE_2;
  if (modelId.startsWith('gpt-image-1.5')) return ImageModels.GPT_IMAGE_1_5;
  if (modelId.startsWith('gpt-image-1-mini')) return ImageModels.GPT_IMAGE_1_MINI;
  if (modelId === 'gpt-image-1') return ImageModels.GPT_IMAGE_1;
  return null;
}

/**
 * Map any Zod-permitted quality/size into the tier+size pair used for price lookup.
 *
 * There is NO reconciliation step for image credits: ImageGeneration.process() calls getCost()
 * once, before the OpenAI call, and sets quest.creditsUsed from it. Whatever this returns is
 * what the user pays, so an input that leaves the render effort up to OpenAI ('auto') is priced
 * at the ceiling rather than at a guess - see AUTO_TIER.
 *
 * Every other under-specified input still defaults leniently (unknown/flexible size -> 1024x1024,
 * omitted quality -> DEFAULT_TIER): throwing here would cascade into a Quest validation failure,
 * because the partial-update path in ImageGeneration.process omits the prompt field.
 */
function normalizeInput(input: OpenAIGPTImageInput): { tier: Tier; size: KnownSize } {
  const tier: Tier = (() => {
    switch (input.quality) {
      case 'standard':
        return 'medium';
      case 'hd':
        return 'high';
      case 'auto':
        return AUTO_TIER;
      case 'low':
      case 'medium':
      case 'high':
        return input.quality;
      default:
        // undefined or any unrecognized value
        return DEFAULT_TIER;
    }
  })();

  const size: KnownSize = isPriceableImageSize(input.size) ? input.size : DEFAULT_SIZE;

  return { tier, size };
}

export class OpenAIImageCostCalculator implements CostCalculator<OpenAICostInput> {
  getCost(input: OpenAICostInput): number {
    const normalizedModel = normalizeModelId(input.model as string);
    if (!normalizedModel) {
      throw new Error(`Unsupported model: ${input.model}`);
    }

    const prices = PRICE_TABLES[normalizedModel];
    if (!prices) {
      throw new Error(`Unsupported model: ${input.model}`);
    }

    const { tier, size } = normalizeInput(input);
    return prices[`${tier}_${size}`];
  }
}

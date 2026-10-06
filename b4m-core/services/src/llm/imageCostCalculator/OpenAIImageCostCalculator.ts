import {
  clampImageQualityForModel,
  GPTImage1Size,
  IMAGE_SIZE_CONSTRAINTS,
  ImageModels,
  isGPTImage25Model,
  OPENAI_IMAGE_MODELS,
  type ExtendedGptImageQuality,
  type OpenAIImageQuality,
} from '@bike4mind/common';
import { CostCalculator } from './types';

export type OpenAIModel = (typeof OPENAI_IMAGE_MODELS)[number] | string;

export interface BaseOpenAIInput {
  model: OpenAIModel;
}

// Mirrors what the Zod OpenAIImageGenerationInput schema actually permits at runtime:
// quality may be undefined or 'auto' (in addition to the listed tiers); size may be undefined,
// null, or an arbitrary 'WxH' string (gpt-image-2 supports flexible sizing).
export interface OpenAIGPTImageInput extends BaseOpenAIInput {
  model: OpenAIModel;
  quality?: OpenAIImageQuality;
  size?: GPTImage1Size | (string & {}) | null;
}

export type OpenAICostInput = OpenAIGPTImageInput;

type BaseTier = 'low' | 'medium' | 'high';
type Tier = BaseTier | ExtendedGptImageQuality;
// The priced sizes are exactly the gpt-image-1 tier's. Widening that list breaks the
// PriceKey-keyed tables below until a price is supplied for each new size, which is the point.
type KnownSize = GPTImage1Size;
type PriceKey = `${BaseTier}_${KnownSize}`;
type ExtendedPriceKey = `${Tier}_${KnownSize}`;

/**
 * The tier a GPT-Image request that names no quality is billed at - and, since #3007, the
 * tier it is also rendered at: both generation dispatch seams pin an omitted quality to this
 * value before the request reaches OpenAI (ImageGeneration.mapQualityForModel for the
 * generate-image route/queue, resolveImageArgs for the agent tool). Exported so the pin and
 * the price can never be edited apart. See normalizeInput's doc comment for the policy.
 */
export const OMITTED_QUALITY_TIER: BaseTier = 'medium';
// OpenAI picks the render effort for `quality: 'auto'` per request and never tells us which
// tier it used, so we bill the ceiling it could have rendered - 'high', or 'max' on the 2.5 models. The prose counterpart of this
// constant lives in OpenAIImageService.toGptImageQuality (utils), which cannot import it. Under-billing is unrecoverable
// (the credit hold is set once, before the call, and never reconciled); over-billing an
// 'auto' request the user opted into is the survivable side of that trade.
const autoTierFor = (model: string): Tier => (isGPTImage25Model(model) ? 'max' : 'high');
const DEFAULT_SIZE: KnownSize = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;

/**
 * The only sizes with a real price row; anything else is estimated at DEFAULT_SIZE.
 * The image_generation tool schema advertises exactly this set to the model so the
 * ledger is never asked to price a size it does not know - must stay in sync with
 * `resolveImageArgs` / the tool's `size` enum, which import it from here.
 *
 * Read from the gpt-image-1 tier rather than retyped, so that sync is enforced rather than
 * just asked for: a size added to the tier widens PriceKey, and GPT_IMAGE_1_PRICES stops
 * type-checking until it gets a price.
 */
export const PRICEABLE_IMAGE_SIZES: readonly KnownSize[] = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes;

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

// Per-image output cost at $30/1M output tokens, from the token formula behind OpenAI's
// image-generation cost calculator. Sunburst and Flare share token rates and token counts.
// 2.5 spends far fewer tokens than gpt-image-2 per tier: its 'high' costs what 2's 'medium'
// does, and its 'max' what 2's 'high' does.
const GPT_IMAGE_2_5_PRICES: Record<ExtendedPriceKey, number> = {
  low_1024x1024: 0.00588,
  low_1024x1536: 0.00474,
  low_1536x1024: 0.00474,
  medium_1024x1024: 0.01317,
  medium_1024x1536: 0.01029,
  medium_1536x1024: 0.01029,
  high_1024x1024: 0.05268,
  high_1024x1536: 0.04116,
  high_1536x1024: 0.04116,
  xhigh_1024x1024: 0.09366,
  xhigh_1024x1536: 0.07377,
  xhigh_1536x1024: 0.07377,
  max_1024x1024: 0.21072,
  max_1024x1536: 0.16464,
  max_1536x1024: 0.16464,
};

// Only the 2.5 tables carry xhigh/max rows; clampImageQualityForModel keeps every other model off them.
const PRICE_TABLES: Partial<Record<ImageModels, Partial<Record<ExtendedPriceKey, number>>>> = {
  [ImageModels.GPT_IMAGE_1]: GPT_IMAGE_1_PRICES,
  [ImageModels.GPT_IMAGE_1_5]: GPT_IMAGE_1_5_PRICES,
  [ImageModels.GPT_IMAGE_1_MINI]: GPT_IMAGE_1_MINI_PRICES,
  [ImageModels.GPT_IMAGE_2]: GPT_IMAGE_2_PRICES,
  [ImageModels.GPT_IMAGE_2_5_SUNBURST]: GPT_IMAGE_2_5_PRICES,
  [ImageModels.GPT_IMAGE_2_5_FLARE]: GPT_IMAGE_2_5_PRICES,
};

/**
 * Normalize versioned model IDs to their base model for pricing lookup.
 * 'gpt-image-2-2026-04-21' -> GPT_IMAGE_2, 'gpt-image-2.5-flare-2026-09-08' -> GPT_IMAGE_2_5_FLARE, etc.
 */
function normalizeModelId(modelId: string): ImageModels | null {
  if (Object.values(ImageModels).includes(modelId as ImageModels)) {
    return modelId as ImageModels;
  }
  // The 2.5 ids also start with 'gpt-image-2', so they must be matched first.
  if (modelId.startsWith(ImageModels.GPT_IMAGE_2_5_SUNBURST)) return ImageModels.GPT_IMAGE_2_5_SUNBURST;
  if (modelId.startsWith(ImageModels.GPT_IMAGE_2_5_FLARE)) return ImageModels.GPT_IMAGE_2_5_FLARE;
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
 * at the ceiling rather than at a guess - see autoTierFor.
 *
 * An OMITTED quality reaches the same dynamic OpenAI selection but is answered the other way
 * round (#3007): rather than reprice it, the generation dispatch sites pin the forwarded
 * quality to OMITTED_QUALITY_TIER, so the render matches the charge and no caller's bill moves.
 * Omitting the field is the most common shape of a minimal API call and is not an opt-in the
 * way an explicit 'auto' is, so a ~4x increase there would punish callers who never asked for
 * high effort; pinning costs them nothing and still closes the gap. Dynamic effort stays
 * available by asking for it - 'auto', priced at the ceiling. Keep this branch on
 * OMITTED_QUALITY_TIER: it is what the pin forwards, so changing one without the other
 * re-opens the mismatch in whichever direction it was moved.
 *
 * Every other under-specified input still defaults leniently (unknown/flexible size -> 1024x1024,
 * unrecognized quality -> OMITTED_QUALITY_TIER): throwing here would cascade into a Quest
 * validation failure, because the partial-update path in ImageGeneration.process omits the
 * prompt field.
 */
function normalizeInput(input: OpenAIGPTImageInput): { tier: Tier; size: KnownSize } {
  const quality = clampImageQualityForModel(input.model, input.quality);
  const tier: Tier = (() => {
    switch (quality) {
      case 'standard':
        return 'medium';
      case 'hd':
        return 'high';
      case 'auto':
        return autoTierFor(input.model);
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
      case 'max':
        return quality;
      default:
        // undefined or any unrecognized value
        return OMITTED_QUALITY_TIER;
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
    const price = prices[`${tier}_${size}`];
    if (price === undefined) {
      throw new Error(`No ${tier} price for ${input.model} at ${size}`);
    }
    return price;
  }
}

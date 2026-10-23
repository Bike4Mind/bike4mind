import { describe, it, expect } from 'vitest';
import { ImageModels, type ModelInfo } from '@bike4mind/common';
import { OpenAIImageCostCalculator } from '../llm/imageCostCalculator/OpenAIImageCostCalculator';
import {
  computeImageUsdCostPerImage,
  estimateImageCredits,
  estimateImageToolCredits,
  UnsupportedImageModelError,
} from './index';

describe('computeImageUsdCostPerImage', () => {
  it('returns 0 for a self-hosted local-image model (no provider spend)', () => {
    expect(
      computeImageUsdCostPerImage('local-image/v1-5-pruned-emaonly', { model: 'local-image/v1-5-pruned-emaonly' })
    ).toBe(0);
  });

  it('does not throw UnsupportedImageModelError for a local-image model', () => {
    expect(() =>
      computeImageUsdCostPerImage('local-image/sd_xl_base', { model: 'local-image/sd_xl_base' })
    ).not.toThrow();
  });

  it('still prices a known Flux model (guard does not affect other models)', () => {
    expect(computeImageUsdCostPerImage(ImageModels.FLUX_PRO_1_1, { model: ImageModels.FLUX_PRO_1_1 })).toBeGreaterThan(
      0
    );
  });

  // Fill is the only BFL model EDIT_SUPPORTED_IMAGE_MODELS allows, so every BFL edit -
  // from ImageEdit.ts and from the chat edit_image tool - prices through this branch.
  // It was missing from the Flux guard, which made those edits throw "Model not supported"
  // the moment the billed model became the model that actually renders.
  it('prices FLUX_PRO_FILL, the only BFL edit model, instead of throwing', () => {
    expect(computeImageUsdCostPerImage(ImageModels.FLUX_PRO_FILL, { model: ImageModels.FLUX_PRO_FILL })).toBe(0.05);
  });

  // BFL's published first-megapixel rates (https://bfl.ai/pricing). The preview endpoints
  // have no published rate and are billed at the sibling they pin, by product decision.
  it.each([
    [ImageModels.FLUX_2_MAX, 0.07],
    [ImageModels.FLUX_2_PRO, 0.03],
    [ImageModels.FLUX_2_PRO_PREVIEW, 0.03],
    [ImageModels.FLUX_2_FLEX, 0.05],
    [ImageModels.FLUX_2_KLEIN_9B, 0.015],
    [ImageModels.FLUX_2_KLEIN_9B_PREVIEW, 0.015],
    [ImageModels.FLUX_2_KLEIN_4B, 0.014],
  ])('prices %s at %s USD per image', (model, usd) => {
    expect(computeImageUsdCostPerImage(model, { model })).toBe(usd);
  });

  // #2899: this is the single seam both charging (validateUserCredits) and the client-side cost
  // preview go through, so the ceiling price for 'auto' has to survive the GPT-image branch's
  // cast into OpenAICostInput - not just the calculator's own unit tests.
  it("prices 'auto' quality at the ceiling tier, matching an explicit 'high'", () => {
    const auto = computeImageUsdCostPerImage(ImageModels.GPT_IMAGE_2, {
      model: ImageModels.GPT_IMAGE_2,
      quality: 'auto',
      size: '1024x1024',
    });
    expect(auto).toBe(0.211);
    expect(auto).toBe(
      computeImageUsdCostPerImage(ImageModels.GPT_IMAGE_2, {
        model: ImageModels.GPT_IMAGE_2,
        quality: 'high',
        size: '1024x1024',
      })
    );
  });

  it('still throws for a genuinely unknown model', () => {
    expect(() => computeImageUsdCostPerImage('totally-made-up-model', { model: 'totally-made-up-model' })).toThrow(
      UnsupportedImageModelError
    );
  });
});

describe('estimateImageCredits input images', () => {
  const gpt2 = { id: ImageModels.GPT_IMAGE_2 } as ModelInfo;
  const input = { model: ImageModels.GPT_IMAGE_2, quality: 'high', size: '1024x1024' } as const;
  const calculator = new OpenAIImageCostCalculator();

  // OpenAI bills the inputs once per request however many images it renders, so a term folded
  // into the per-image price would be charged n times over.
  it('adds the input term once, not per output image', () => {
    const { usdCost } = estimateImageCredits(gpt2, 3, { ...input, inputImageCount: 2 });
    expect(usdCost).toBeCloseTo(
      3 * calculator.getCost(input) + calculator.getInputImageCost({ ...input, inputImageCount: 2 }),
      10
    );
  });

  it('costs exactly what it did before when there are no input images', () => {
    expect(estimateImageCredits(gpt2, 3, input).usdCost).toBe(3 * calculator.getCost(input));
  });

  it('adds no input term for a non-GPT model', () => {
    const flux = { id: ImageModels.FLUX_PRO_1_1 } as ModelInfo;
    expect(estimateImageCredits(flux, 2, { model: flux.id, inputImageCount: 4 } as never)).toEqual(
      estimateImageCredits(flux, 2, { model: flux.id })
    );
  });
});

describe('estimateImageToolCredits', () => {
  const models = [
    { id: ImageModels.GPT_IMAGE_2 },
    { id: ImageModels.GPT_IMAGE_1 },
    { id: ImageModels.FLUX_PRO_1_1 },
  ] as ModelInfo[];
  const gpt2 = models[0];

  it('prices one image at the saved quality and size', () => {
    const result = estimateImageToolCredits(models, {
      model: ImageModels.GPT_IMAGE_2,
      quality: 'high',
      size: '1536x1024',
    });
    expect(result).toEqual({
      model: ImageModels.GPT_IMAGE_2,
      credits: estimateImageCredits(gpt2, 1, { model: gpt2.id, quality: 'high', size: '1536x1024' }).requiredCredits,
    });
  });

  it('ignores a saved n so the figure stays per image', () => {
    expect(estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_2, quality: 'low', n: 4 })).toEqual(
      estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_2, quality: 'low' })
    );
  });

  // Settlement runs the tool's args through resolveImageArgs, which upgrades gpt-image-1 and pins
  // an omitted GPT quality; the preview must price what that charges, not the raw selection.
  it('prices gpt-image-1 as the gpt-image-2 it is upgraded to', () => {
    expect(estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_1, quality: 'high' })).toEqual(
      estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_2, quality: 'high' })
    );
  });

  it('prices an omitted GPT quality at the pinned tier', () => {
    expect(estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_2 })).toEqual(
      estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_2, quality: 'medium' })
    );
  });

  it('defaults to gpt-image-2 when nothing is saved', () => {
    expect(estimateImageToolCredits(models, undefined)?.model).toBe(ImageModels.GPT_IMAGE_2);
  });

  it('prices a flat-rate model', () => {
    expect(estimateImageToolCredits(models, { model: ImageModels.FLUX_PRO_1_1 })?.credits).toBeGreaterThan(0);
  });

  // usdToCredits floors at 1 credit, but settlement charges a free model nothing.
  it('prices a free local-image model at 0 credits', () => {
    const local = [{ id: 'local-image/sd_xl' }] as ModelInfo[];
    expect(estimateImageToolCredits(local, { model: 'local-image/sd_xl' as never })).toEqual({
      model: 'local-image/sd_xl',
      credits: 0,
    });
  });

  it('returns null for a model missing from the list or with no price', () => {
    expect(estimateImageToolCredits(models, { model: ImageModels.GPT_IMAGE_1_5 })).toBeNull();
    const unpriced = [{ id: 'not-an-image-model' }] as ModelInfo[];
    expect(estimateImageToolCredits(unpriced, { model: 'not-an-image-model' as never })).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { ImageModels, type ModelInfo } from '@bike4mind/common';
import { OpenAIImageCostCalculator } from '../llm/imageCostCalculator/OpenAIImageCostCalculator';
import { computeImageUsdCostPerImage, estimateImageCredits, UnsupportedImageModelError } from './index';

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

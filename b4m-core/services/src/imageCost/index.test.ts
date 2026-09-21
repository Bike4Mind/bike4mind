import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { computeImageUsdCostPerImage, UnsupportedImageModelError } from './index';

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

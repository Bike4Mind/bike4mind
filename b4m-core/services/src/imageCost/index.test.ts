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

  it('still throws for a genuinely unknown model', () => {
    expect(() => computeImageUsdCostPerImage('totally-made-up-model', { model: 'totally-made-up-model' })).toThrow(
      UnsupportedImageModelError
    );
  });
});

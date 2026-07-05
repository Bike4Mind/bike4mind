import { describe, it, expect } from 'vitest';
import { GeminiImageCostCalculator } from './GeminiImageCostCalculator';
import { ImageModels } from '@bike4mind/common';

describe('GeminiImageCostCalculator', () => {
  const calculator = new GeminiImageCostCalculator();

  // Per-image USD: ~1290 output tokens x output-$/1M, rounded up to never under-hold credits.
  describe('per-model pricing', () => {
    it('prices Gemini 2.5 Flash Image at $30/1M output', () => {
      expect(calculator.getCost({ model: ImageModels.GEMINI_2_5_FLASH_IMAGE })).toBe(0.039);
    });

    it('prices Gemini 3 Pro Image Preview at $30/1M output', () => {
      expect(calculator.getCost({ model: ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW })).toBe(0.039);
    });

    it('prices Gemini 3 Pro Image (Nano Banana Pro) at $120/1M output', () => {
      expect(calculator.getCost({ model: ImageModels.GEMINI_3_PRO_IMAGE })).toBe(0.155);
    });

    it('prices Gemini 3.1 Flash Image (Nano Banana 2) at $60/1M output', () => {
      expect(calculator.getCost({ model: ImageModels.GEMINI_3_1_FLASH_IMAGE })).toBe(0.078);
    });
  });

  describe('unsupported models', () => {
    it('throws for a non-Gemini image model', () => {
      // Cast: getCost is typed to GeminiImageModel, but the routing layer can pass any
      // ImageModels id, so the runtime guard must reject anything outside the price map.
      expect(() => calculator.getCost({ model: ImageModels.GPT_IMAGE_1 as never })).toThrow(
        `Unsupported Gemini image model: ${ImageModels.GPT_IMAGE_1}`
      );
    });

    it('throws for a completely unknown model', () => {
      expect(() => calculator.getCost({ model: 'dall-e-2' as never })).toThrow(
        'Unsupported Gemini image model: dall-e-2'
      );
    });
  });
});

import { describe, it, expect } from 'vitest';
import { OpenAIImageCostCalculator } from './OpenAIImageCostCalculator';
import { ImageModels } from '@bike4mind/common';

describe('OpenAIImageCostCalculator', () => {
  const calculator = new OpenAIImageCostCalculator();

  describe('gpt-image-1', () => {
    it('returns correct price for low quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1, quality: 'low', size: '1024x1024' })).toBe(0.011);
    });

    it('returns correct price for medium quality 1024x1536', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1, quality: 'medium', size: '1024x1536' })).toBe(0.063);
    });

    it('returns correct price for high quality 1536x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1, quality: 'high', size: '1536x1024' })).toBe(0.25);
    });

    it('maps legacy "standard" quality to medium pricing', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1, quality: 'standard', size: '1024x1024' })).toBe(
        0.042
      );
    });

    it('maps legacy "hd" quality to high pricing', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1, quality: 'hd', size: '1024x1024' })).toBe(0.167);
    });
  });

  describe('gpt-image-1.5', () => {
    it('returns correct price for low quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1_5, quality: 'low', size: '1024x1024' })).toBe(0.009);
    });

    it('returns correct price for medium quality 1024x1536', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1_5, quality: 'medium', size: '1024x1536' })).toBe(0.05);
    });

    it('returns correct price for high quality 1536x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1_5, quality: 'high', size: '1536x1024' })).toBe(0.2);
    });

    it('accepts versioned model ID "gpt-image-1.5" string', () => {
      expect(calculator.getCost({ model: 'gpt-image-1.5', quality: 'low', size: '1024x1024' })).toBe(0.009);
    });
  });

  describe('gpt-image-1-mini', () => {
    it('returns correct price for low quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1_MINI, quality: 'low', size: '1024x1024' })).toBe(
        0.005
      );
    });

    it('returns correct price for high quality 1024x1536', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_1_MINI, quality: 'high', size: '1024x1536' })).toBe(
        0.052
      );
    });
  });

  describe('gpt-image-2', () => {
    it('returns correct price for low quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'low', size: '1024x1024' })).toBe(0.006);
    });

    it('returns correct price for low quality 1024x1536 (cheaper than 1024x1024)', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'low', size: '1024x1536' })).toBe(0.005);
    });

    it('returns correct price for medium quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'medium', size: '1024x1024' })).toBe(0.053);
    });

    it('returns correct price for high quality 1536x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'high', size: '1536x1024' })).toBe(0.165);
    });

    it('returns correct price for high quality 1024x1024', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'high', size: '1024x1024' })).toBe(0.211);
    });

    it('maps legacy "standard" quality to medium pricing', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'standard', size: '1024x1024' })).toBe(
        0.053
      );
    });

    it('maps legacy "hd" quality to high pricing', () => {
      expect(calculator.getCost({ model: ImageModels.GPT_IMAGE_2, quality: 'hd', size: '1024x1024' })).toBe(0.211);
    });

    it('accepts versioned model ID "gpt-image-2-2026-04-21"', () => {
      expect(calculator.getCost({ model: 'gpt-image-2-2026-04-21', quality: 'low', size: '1024x1024' })).toBe(0.006);
    });
  });

  // The Zod schema permits `quality: undefined | 'auto'` and `size: undefined | null | 'WxH'`.
  // The calculator must return a finite estimate for every combination - throwing here cascades
  // into a Quest validation failure ("prompt is required") because the partial-update path in
  // ImageGeneration.process omits the prompt field. Cost is an estimate; we settle on the actual
  // charge separately, so unknown inputs default to medium/1024x1024.
  describe('lenient defaulting (regression for #8621)', () => {
    const models = [
      { model: ImageModels.GPT_IMAGE_1, expectedMedium1024: 0.042 },
      { model: ImageModels.GPT_IMAGE_1_5, expectedMedium1024: 0.034 },
      { model: ImageModels.GPT_IMAGE_1_MINI, expectedMedium1024: 0.011 },
      { model: ImageModels.GPT_IMAGE_2, expectedMedium1024: 0.053 },
    ] as const;

    for (const { model, expectedMedium1024 } of models) {
      describe(model, () => {
        it('defaults undefined quality to medium pricing', () => {
          expect(calculator.getCost({ model, quality: undefined, size: '1024x1024' })).toBe(expectedMedium1024);
        });

        it('defaults "auto" quality to medium pricing', () => {
          expect(calculator.getCost({ model, quality: 'auto', size: '1024x1024' })).toBe(expectedMedium1024);
        });

        it('defaults undefined size to 1024x1024', () => {
          expect(calculator.getCost({ model, quality: 'medium', size: undefined })).toBe(expectedMedium1024);
        });

        it('defaults null size to 1024x1024', () => {
          expect(calculator.getCost({ model, quality: 'medium', size: null })).toBe(expectedMedium1024);
        });

        it('falls back to 1024x1024 pricing for flexible/unknown sizes', () => {
          // Covers BFL-only sizes and gpt-image-2 flexible sizing alike.
          expect(calculator.getCost({ model, quality: 'medium', size: '1440x810' })).toBe(expectedMedium1024);
        });

        it('handles a fully omitted quality and size', () => {
          expect(calculator.getCost({ model })).toBe(expectedMedium1024);
        });
      });
    }
  });

  describe('unsupported models', () => {
    it('throws for completely unknown model', () => {
      expect(() => calculator.getCost({ model: 'dall-e-2', quality: 'standard', size: '1024x1024' })).toThrow(
        'Unsupported model: dall-e-2'
      );
    });
  });
});

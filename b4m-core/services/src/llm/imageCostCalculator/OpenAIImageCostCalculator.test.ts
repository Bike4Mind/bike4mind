import { describe, it, expect } from 'vitest';
import { OMITTED_QUALITY_TIER, OpenAIImageCostCalculator } from './OpenAIImageCostCalculator';
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
  // ImageGeneration.process omits the prompt field. Unknown inputs therefore default to
  // medium/1024x1024. `quality: 'auto'` is the exception and is covered by its own suite below:
  // it is priced at the ceiling, not defaulted.
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

  // Regression for #2899. OpenAI resolves `quality: 'auto'` to its own render effort per request
  // and the image-credit path holds credits exactly once, before the call, with no reconciliation
  // afterwards - so 'auto' must be priced at the highest tier OpenAI could have rendered.
  describe("'auto' quality is billed at the ceiling tier", () => {
    const models = [
      { model: ImageModels.GPT_IMAGE_1, high1024: 0.167, high1536: 0.25, medium1024: 0.042 },
      { model: ImageModels.GPT_IMAGE_1_5, high1024: 0.133, high1536: 0.2, medium1024: 0.034 },
      { model: ImageModels.GPT_IMAGE_1_MINI, high1024: 0.036, high1536: 0.052, medium1024: 0.011 },
      { model: ImageModels.GPT_IMAGE_2, high1024: 0.211, high1536: 0.165, medium1024: 0.053 },
    ] as const;

    for (const { model, high1024, high1536, medium1024 } of models) {
      describe(model, () => {
        it('prices "auto" at the high tier, not the medium default', () => {
          expect(calculator.getCost({ model, quality: 'auto', size: '1024x1024' })).toBe(high1024);
        });

        it('prices "auto" at the high tier for every known size', () => {
          expect(calculator.getCost({ model, quality: 'auto', size: '1024x1536' })).toBe(high1536);
          expect(calculator.getCost({ model, quality: 'auto', size: '1536x1024' })).toBe(high1536);
        });

        it('prices "auto" at the high tier when the size falls back to 1024x1024', () => {
          expect(calculator.getCost({ model, quality: 'auto', size: undefined })).toBe(high1024);
          expect(calculator.getCost({ model, quality: 'auto', size: null })).toBe(high1024);
          expect(calculator.getCost({ model, quality: 'auto', size: '1440x810' })).toBe(high1024);
        });

        it('charges "auto" exactly what an explicit "high" costs', () => {
          expect(calculator.getCost({ model, quality: 'auto', size: '1024x1536' })).toBe(
            calculator.getCost({ model, quality: 'high', size: '1024x1536' })
          );
        });

        // An omitted quality is the other half of the same root cause and is answered the other
        // way round (#3007): its price does not move, the dispatch sites pin the forwarded tier
        // to match it instead. So a change to 'auto' must not silently drag this along.
        it('leaves an omitted quality on the medium default', () => {
          expect(calculator.getCost({ model, quality: undefined, size: '1024x1024' })).toBe(medium1024);
        });
      });
    }
  });

  // #3007: an omitted quality is not repriced - it is pinned on dispatch to the tier billed
  // here, so the render matches the charge. OMITTED_QUALITY_TIER is the single value both
  // halves read; these fail if the price and the pin are ever edited apart.
  describe('omitted quality is priced at OMITTED_QUALITY_TIER', () => {
    const models = [
      ImageModels.GPT_IMAGE_1,
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GPT_IMAGE_1_MINI,
      ImageModels.GPT_IMAGE_2,
    ] as const;

    for (const model of models) {
      describe(model, () => {
        it.each(['1024x1024', '1024x1536', '1536x1024'] as const)(
          'charges an omitted quality exactly what the pinned tier costs at %s',
          size => {
            expect(calculator.getCost({ model, quality: undefined, size })).toBe(
              calculator.getCost({ model, quality: OMITTED_QUALITY_TIER, size })
            );
          }
        );

        it('agrees with the pinned tier when the size also falls back', () => {
          expect(calculator.getCost({ model })).toBe(calculator.getCost({ model, quality: OMITTED_QUALITY_TIER }));
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

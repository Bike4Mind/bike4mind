import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { resolveImageArgs, type ImageToolArgs } from './resolveImageArgs';
import { PRICEABLE_IMAGE_SIZES } from '../../../imageCostCalculator/OpenAIImageCostCalculator';

describe('resolveImageArgs', () => {
  it('lets each tool-call arg win over the client imageConfig value', () => {
    const resolved = resolveImageArgs(
      { model: ImageModels.GPT_IMAGE_2, n: 2, size: '1024x1024', quality: 'low' },
      { n: 1, size: '1024x1536', quality: 'high' }
    );

    expect(resolved).toEqual({
      model: ImageModels.GPT_IMAGE_2,
      n: 1,
      size: '1024x1536',
      quality: 'high',
    });
  });

  it('falls back to the client imageConfig for every omitted arg', () => {
    const resolved = resolveImageArgs(
      { model: ImageModels.GPT_IMAGE_2, n: 3, size: '1536x1024', quality: 'medium' },
      {}
    );

    expect(resolved).toEqual({
      model: ImageModels.GPT_IMAGE_2,
      n: 3,
      size: '1536x1024',
      quality: 'medium',
    });
  });

  it('defaults n to 1 when neither side supplies it', () => {
    expect(resolveImageArgs(undefined, {}).n).toBe(1);
  });

  it('never takes the model from the tool args', () => {
    // The schema exposes no model parameter, so this can only arrive from a crafted caller.
    const toolArgs: ImageToolArgs & { model?: string } = { model: ImageModels.FLUX_PRO_ULTRA };

    expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2 }, toolArgs).model).toBe(ImageModels.GPT_IMAGE_2);
  });

  it('upgrades gpt-image-1 to gpt-image-2 for both billing and dispatch', () => {
    expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_1 }, {}).model).toBe(ImageModels.GPT_IMAGE_2);
  });

  it('defaults to the current GPT-image model when no config is supplied', () => {
    expect(resolveImageArgs(undefined, {}).model).toBe(ImageModels.GPT_IMAGE_2);
  });

  // The tool schema only offers priceable sizes, but an enum is advisory - a model that
  // invents '1792x1024' would render at that size and bill at the 1024x1024 price row.
  describe('model-supplied size', () => {
    it.each(PRICEABLE_IMAGE_SIZES)('lets a priceable %s win over the client imageConfig', size => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2, size: '1024x1024' }, { size }).size).toBe(size);
    });

    it.each(['1792x1024', '1024x1792', '256x256', '512x512', 'auto', 'not-a-size'])(
      'discards unpriceable %s in favor of the client imageConfig',
      size => {
        expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2, size: '1536x1024' }, { size }).size).toBe(
          '1536x1024'
        );
      }
    );

    it('leaves size undefined when it is unpriceable and the client supplied none', () => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2 }, { size: '1792x1024' }).size).toBeUndefined();
    });

    // The panel is authoritative for its own exotic presets: gpt-image-2 renders them and the
    // calculator estimates at 1024x1024, which is the pre-existing (documented) behavior.
    it('still honors a client imageConfig size outside the priceable set', () => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2, size: '2048x2048' }, {}).size).toBe('2048x2048');
    });
  });
});

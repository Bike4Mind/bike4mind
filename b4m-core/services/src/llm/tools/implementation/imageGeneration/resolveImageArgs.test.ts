import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { resolveImageArgs, type ImageToolArgs } from './resolveImageArgs';
import { OMITTED_QUALITY_TIER, PRICEABLE_IMAGE_SIZES } from '../../../imageCostCalculator/OpenAIImageCostCalculator';

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

  // #3007: neither side naming a tier used to leave `quality` undefined, which is dropped from
  // the OpenAI call - OpenAI then picks the effort itself and can render above the tier the
  // reservation already held, with no reconciliation afterwards. The pin is the billed tier, so
  // this changes no reservation, only what OpenAI is actually asked for.
  describe('omitted quality', () => {
    it.each([ImageModels.GPT_IMAGE_1_5, ImageModels.GPT_IMAGE_1_MINI, ImageModels.GPT_IMAGE_2])(
      'pins %s to the tier the reservation bills',
      model => {
        expect(resolveImageArgs({ model }, {}).quality).toBe(OMITTED_QUALITY_TIER);
      }
    );

    it('pins the default model when no imageConfig is supplied at all', () => {
      expect(resolveImageArgs(undefined, {}).quality).toBe(OMITTED_QUALITY_TIER);
    });

    // gpt-image-1 is upgraded to gpt-image-2 above, so the pin has to survive that rewrite.
    it('pins after the gpt-image-1 upgrade', () => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_1 }, {}).quality).toBe(OMITTED_QUALITY_TIER);
    });

    it.each([ImageModels.FLUX_PRO_ULTRA, ImageModels.GEMINI_2_5_FLASH_IMAGE, 'local-image/Deliberate v2'])(
      'leaves %s undefined - no tier concept, and not priced by this calculator',
      model => {
        expect(resolveImageArgs({ model } as never, {}).quality).toBeUndefined();
      }
    );

    // 'auto' is the opt-in escape hatch the pin leaves open: it bills at the ceiling (PR #2977)
    // and must keep reaching OpenAI unresolved.
    it.each(['auto', 'low', 'high'] as const)('never overrides an explicit %s from the tool call', quality => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2 }, { quality }).quality).toBe(quality);
    });

    it('never overrides an explicit tier from the client imageConfig', () => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2, quality: 'low' }, {}).quality).toBe('low');
    });

    // The OpenAI SDK types these args nullable; a null must pin, not survive as a null.
    it('treats a null tool-call quality as omitted', () => {
      expect(resolveImageArgs({ model: ImageModels.GPT_IMAGE_2 }, { quality: null }).quality).toBe(
        OMITTED_QUALITY_TIER
      );
    });
  });
});

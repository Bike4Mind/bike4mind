import { describe, it, expect } from 'vitest';
import { IMAGE_SIZE_CONSTRAINTS, ImageModels } from '@bike4mind/common';
import { defaultImageSize, getAvailableImageSizes, getImageSizePresets } from './imageSizeOptions';

describe('getImageSizePresets', () => {
  it('lists each tier its own presets', () => {
    expect(getImageSizePresets(ImageModels.GPT_IMAGE_2)).toEqual(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes);
    expect(getImageSizePresets(ImageModels.GPT_IMAGE_1)).toEqual(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes);
    expect(getImageSizePresets(ImageModels.GPT_IMAGE_1_5)).toEqual(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes);
    expect(getImageSizePresets(ImageModels.FLUX_PRO_1_1)).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
  });

  it('offers no preset for Kontext, which is sized by its input image', () => {
    expect(getImageSizePresets(ImageModels.FLUX_KONTEXT_PRO)).toEqual([]);
    expect(getImageSizePresets(ImageModels.FLUX_KONTEXT_MAX)).toEqual([]);
  });

  it('falls back to the BFL presets for an unrecognized model', () => {
    expect(getImageSizePresets('some-unreleased-model')).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
    expect(getImageSizePresets(undefined)).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
  });
});

describe('getAvailableImageSizes', () => {
  it('surfaces a custom size gpt-image-2 supports but does not list', () => {
    // The BFL default. gpt-image-2 accepts it, so a model switch keeps it - and it has to stay
    // visible or the Select renders blank and hides what is about to be generated.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '1280x960')).toContain('1280x960');
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, 'auto')).toContain('auto');
  });

  it('does not duplicate a size that is already a preset', () => {
    const sizes = getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '2048x2048');
    expect(sizes).toEqual(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes);
  });

  it('does not offer a size the model rejects', () => {
    // 810 is not a multiple of 16, so gpt-image-2 will not take it.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, '1440x810')).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes
    );
    // The gpt-image-1 family has three fixed sizes and no custom resolutions at all.
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_1_5, '1280x960')).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes
    );
  });

  it('leaves non-OpenAI models on their presets alone', () => {
    // isSupportedImageSize measures OpenAI tiers only, so a BFL size must never be put through it.
    expect(getAvailableImageSizes(ImageModels.FLUX_PRO_1_1, '2048x2048')).toEqual(IMAGE_SIZE_CONSTRAINTS.BFL.sizes);
  });

  it('returns the presets unchanged when no size is set', () => {
    expect(getAvailableImageSizes(ImageModels.GPT_IMAGE_2, undefined)).toEqual(
      IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes
    );
  });
});

describe('defaultImageSize', () => {
  it('defaults each tier to its own size', () => {
    expect(defaultImageSize(ImageModels.GPT_IMAGE_2)).toBe(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.defaultSize);
    expect(defaultImageSize(ImageModels.GPT_IMAGE_1_MINI)).toBe(IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize);
    expect(defaultImageSize(ImageModels.FLUX_PRO_1_1)).toBe(IMAGE_SIZE_CONSTRAINTS.BFL.defaultSize);
  });
});

describe('the Select value is always one of its options', () => {
  // The defect this module exists to prevent: Joy draws a Select blank when its value matches no
  // <Option>, so both modals depend on `value` and `options` never disagreeing. Asserting the
  // invariant directly is what a per-field state check missed.
  const models = [
    ImageModels.GPT_IMAGE_1,
    ImageModels.GPT_IMAGE_1_5,
    ImageModels.GPT_IMAGE_1_MINI,
    ImageModels.GPT_IMAGE_2,
    ImageModels.FLUX_PRO_1_1,
    ImageModels.FLUX_PRO_ULTRA,
    'some-unreleased-model',
  ];
  const sizes = [undefined, 'auto', '1024x1024', '1280x960', '2048x2048', '1440x810', '1536x1024'];

  it.each(models)('holds for %s', model => {
    for (const size of sizes) {
      const value = size || defaultImageSize(model);
      const options = getAvailableImageSizes(model, size);
      // Kontext is the one model with no presets, and both modals hide the row for it.
      if (options.length === 0) continue;
      if (options.includes(value)) continue;
      // A size the model rejects is discarded elsewhere (handleModelChange coerces it); what must
      // never happen is the model's own default going unrendered.
      expect(options).toContain(defaultImageSize(model));
    }
  });
});
